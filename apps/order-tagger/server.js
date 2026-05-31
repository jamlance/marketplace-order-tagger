import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, orderStatusName } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[order-tagger] Missing env: ${k}`); process.exit(1); }
}

// Tags themselves live on the Inkress order's meta_data (source of truth).
// Postgres only holds: the auto-tag RULES, a colour PALETTE of named tags,
// per-merchant webhook subscription bookkeeping, and a seen-event set for
// idempotent real-time auto-tagging.
const db = await openPg("order_tagger", `
  CREATE TABLE IF NOT EXISTS rules (
    id              BIGSERIAL PRIMARY KEY,
    merchant_id     BIGINT NOT NULL,
    label           TEXT NOT NULL,
    min_total       NUMERIC,
    max_total       NUMERIC,
    status_is       TEXT,
    currency_is     TEXT,
    email_contains  TEXT,
    name_contains   TEXT,
    title_contains  TEXT,
    repeat_customer BOOLEAN NOT NULL DEFAULT false,
    created_by_id   BIGINT,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE rules ADD COLUMN IF NOT EXISTS max_total      NUMERIC;
  ALTER TABLE rules ADD COLUMN IF NOT EXISTS email_contains TEXT;
  ALTER TABLE rules ADD COLUMN IF NOT EXISTS name_contains  TEXT;
  ALTER TABLE rules ADD COLUMN IF NOT EXISTS title_contains TEXT;
  CREATE INDEX IF NOT EXISTS idx_rules_merchant ON rules (merchant_id, id);

  CREATE TABLE IF NOT EXISTS tags (
    id          BIGSERIAL PRIMARY KEY,
    merchant_id BIGINT NOT NULL,
    label       TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'slate',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_uniq ON tags (merchant_id, lower(label));

  CREATE TABLE IF NOT EXISTS webhook_subs (
    merchant_id   BIGINT PRIMARY KEY,
    url           TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS webhook_seen (
    webhook_id TEXT PRIMARY KEY,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const COLORS = ["slate", "blue", "green", "amber", "red", "purple", "pink", "teal"];

const app = express();
// The webhook receiver verifies an HMAC over the EXACT bytes Inkress sent, so it
// needs the raw body. Register a raw parser for that path BEFORE core mounts
// express.json() (express.json skips requests whose body is already parsed).
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));

let tokens; // per-merchant refresh-token store (offline_access) for background PATCH

const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE,
  frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  // Persist each merchant's refresh token so the webhook receiver can write
  // tags back with no live dashboard session (requires offline_access).
  onBootstrap: (entry) => {
    if (tokens && entry?.merchantId && entry.refreshToken) {
      tokens.save(entry.merchantId, entry.refreshToken).catch(() => {});
    }
  },
});

tokens = await openMerchantTokens("order_tagger", core.cfg);

const DASH_BASE = process.env.INKRESS_DASHBOARD_BASE || "https://dev.inkress.com";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";

function mapOrder(o) {
  const meta = o.meta_data || {};
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  return {
    id: o.id,
    ref: o.reference_id || String(o.id),
    total: Number(o.total || 0),
    currency: o.currency?.code || o.currency_code || "JMD",
    status: orderStatusName(o),
    title: o.title || o.order_detail?.title || null,
    customer: o.customer
      ? {
          name: [o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email || null,
          email: o.customer.email || null,
          phone: o.customer.phone || null,
          id: o.customer.id ?? null,
        }
      : null,
    created_at: o.inserted_at || o.created_at || null,
    tags,
    tag_log: Array.isArray(meta.tag_log) ? meta.tag_log : [],
    inkress_url: `${DASH_BASE}/dashboard/orders/${o.id}`,
  };
}

async function fetchOrders(session, limit = 50) {
  const r = await inkressApi(core.cfg, session.accessToken, `orders?limit=${limit}&order=id desc`);
  return (r?.result?.entries || []).map(mapOrder);
}
async function fetchOrderRaw(session, id) {
  const r = await inkressApi(core.cfg, session.accessToken, `orders/${encodeURIComponent(id)}`);
  return r?.result || null;
}

// Merge tags onto an order's meta_data and PATCH it back. `mutate(tags)` returns
// the new tags array; we append a tag_log entry per change. `apiCall` is a thin
// wrapper so this works with either a live session token or a background token.
async function writeTagsWith(apiCall, actor, id, mutate, logEntries) {
  const r = await apiCall(`orders/${encodeURIComponent(id)}`);
  const raw = r?.result || null;
  if (!raw) throw new Error("order_not_found");
  const meta = raw.meta_data || {};
  const current = Array.isArray(meta.tags) ? meta.tags : [];
  const nextTags = mutate(current);
  const log = Array.isArray(meta.tag_log) ? meta.tag_log : [];
  const stamp = new Date().toISOString();
  for (const e of logEntries) log.push({ ...e, by: actor?.name || "staff", by_id: actor?.id || null, at: stamp });
  const meta_data = { ...meta, tags: nextTags, tag_log: log.slice(-50) };
  await apiCall(`orders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ meta_data }) });
  return { tags: nextTags, tag_log: meta_data.tag_log };
}
const sessionApi = (session) => (p, init) => inkressApi(core.cfg, session.accessToken, p, init);

function ruleMatches(rule, order, repeatEmails) {
  if (rule.min_total != null && order.total < Number(rule.min_total)) return false;
  if (rule.max_total != null && order.total > Number(rule.max_total)) return false;
  if (rule.status_is && order.status !== String(rule.status_is).toLowerCase()) return false;
  if (rule.currency_is && order.currency.toUpperCase() !== String(rule.currency_is).toUpperCase()) return false;
  const email = (order.customer?.email || "").toLowerCase();
  const name = (order.customer?.name || "").toLowerCase();
  if (rule.email_contains && !email.includes(String(rule.email_contains).toLowerCase())) return false;
  if (rule.name_contains && !name.includes(String(rule.name_contains).toLowerCase())) return false;
  if (rule.title_contains) {
    const hay = `${order.title || ""} ${(order.lines || []).map((l) => l.title || l.product_name || "").join(" ")}`.toLowerCase();
    if (!hay.includes(String(rule.title_contains).toLowerCase())) return false;
  }
  // repeat_customer needs cross-order history; only evaluable when a repeatEmails
  // set is supplied (recent-orders scan), not in the single-order webhook path.
  if (rule.repeat_customer) {
    if (!repeatEmails) return false;
    if (!(email && repeatEmails.has(email))) return false;
  }
  return true;
}
function matchingLabels(order, rules, repeatEmails) {
  return rules.filter((rl) => ruleMatches(rl, order, repeatEmails)).map((rl) => rl.label);
}
function repeatSet(orders) {
  const counts = new Map();
  for (const o of orders) {
    const e = (o.customer?.email || "").toLowerCase();
    if (e) counts.set(e, (counts.get(e) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([e]) => e));
}
async function paletteMap(merchantId) {
  const rows = await db.q(`SELECT label, color FROM tags WHERE merchant_id=$1`, [merchantId]);
  const m = {};
  for (const r of rows) m[r.label] = r.color;
  return m;
}

// ---- Orders ----------------------------------------------------------------
app.get("/api/orders", core.requireSession, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  try {
    const orders = await fetchOrders(req.session, limit);
    const rules = await db.q(`SELECT * FROM rules WHERE merchant_id=$1 ORDER BY id`, [req.session.merchantId]);
    const repeatEmails = repeatSet(orders);
    for (const o of orders) o.suggested = matchingLabels(o, rules, repeatEmails).filter((l) => !o.tags.includes(l));

    const palette = await paletteMap(req.session.merchantId);
    const tagCounts = {};
    for (const o of orders) for (const t of o.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const allTags = [...new Set([...orders.flatMap((o) => o.tags), ...Object.keys(palette)])].sort();
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count }));

    res.json({
      orders,
      palette,
      meta: {
        total: orders.length,
        tagged: orders.filter((o) => o.tags.length).length,
        untagged: orders.filter((o) => !o.tags.length).length,
        suggestions: orders.reduce((s, o) => s + o.suggested.length, 0),
        tags: allTags,
        top_tags: topTags,
      },
    });
  } catch (err) { res.status(502).json({ error: "orders_failed", message: err?.message }); }
});

app.get("/api/orders/:id", core.requireSession, async (req, res) => {
  try {
    const raw = await fetchOrderRaw(req.session, req.params.id);
    if (!raw) return res.status(404).json({ error: "not_found" });
    const order = mapOrder(raw);
    order.lines = (raw.lines || raw.order_lines || raw.order_items || raw.line_items || raw.items || []).map((li) => ({
      title: li.product_variant_name_frozen || li.title || li.product?.title || li.name || li.product_name || "Item",
      qty: Number(li.quantity ?? li.qty ?? 1),
      price: Number(li.product_variant_total_frozen ?? li.price ?? li.unit_price ?? 0),
    }));
    res.json({ order });
  } catch (err) { res.status(502).json({ error: "order_failed", message: err?.message }); }
});

app.post("/api/orders/:id/tags", core.requireSession, async (req, res) => {
  const label = String(req.body?.label || "").trim().slice(0, 40);
  if (!label) return res.status(400).json({ error: "no_label", message: "Tag needs a label." });
  try {
    const out = await writeTagsWith(sessionApi(req.session), req.actor, req.params.id,
      (cur) => (cur.includes(label) ? cur : [...cur, label]),
      [{ label, action: "add" }]);
    res.json(out);
  } catch (err) { res.status(502).json({ error: "tag_failed", message: err?.message }); }
});

app.delete("/api/orders/:id/tags/:label", core.requireSession, async (req, res) => {
  const label = String(req.params.label || "");
  try {
    const out = await writeTagsWith(sessionApi(req.session), req.actor, req.params.id,
      (cur) => cur.filter((t) => t !== label),
      [{ label, action: "remove" }]);
    res.json(out);
  } catch (err) { res.status(502).json({ error: "untag_failed", message: err?.message }); }
});

// Bulk apply / remove one tag across many orders.
app.post("/api/orders/bulk/tags", core.requireSession, async (req, res) => {
  const label = String(req.body?.label || "").trim().slice(0, 40);
  const action = req.body?.action === "remove" ? "remove" : "add";
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
  if (!label) return res.status(400).json({ error: "no_label", message: "Tag needs a label." });
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Select at least one order." });
  let changed = 0;
  for (const id of ids) {
    try {
      await writeTagsWith(sessionApi(req.session), req.actor, id,
        (cur) => action === "add"
          ? (cur.includes(label) ? cur : [...cur, label])
          : cur.filter((t) => t !== label),
        [{ label, action }]);
      changed++;
    } catch { /* skip individual failures */ }
  }
  res.json({ changed, action, label });
});

// ---- Tag palette -----------------------------------------------------------
app.get("/api/tags", core.requireSession, async (req, res) => {
  res.json({ tags: await db.q(`SELECT * FROM tags WHERE merchant_id=$1 ORDER BY label`, [req.session.merchantId]) });
});
app.post("/api/tags", core.requireSession, async (req, res) => {
  const label = String(req.body?.label || "").trim().slice(0, 40);
  const color = COLORS.includes(req.body?.color) ? req.body.color : "slate";
  if (!label) return res.status(400).json({ error: "no_label", message: "Tag needs a label." });
  try {
    const row = await db.one(
      `INSERT INTO tags (merchant_id, label, color) VALUES ($1,$2,$3)
       ON CONFLICT (merchant_id, lower(label)) DO UPDATE SET color=$3 RETURNING *`,
      [req.session.merchantId, label, color]);
    res.status(201).json({ tag: row });
  } catch (err) { res.status(500).json({ error: "tag_save_failed", message: err?.message }); }
});
app.patch("/api/tags/:id", core.requireSession, async (req, res) => {
  const color = COLORS.includes(req.body?.color) ? req.body.color : null;
  if (!color) return res.status(400).json({ error: "bad_color" });
  const row = await db.one(`UPDATE tags SET color=$1 WHERE id=$2 AND merchant_id=$3 RETURNING *`,
    [color, req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ tag: row });
});
app.delete("/api/tags/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM tags WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// ---- Rules -----------------------------------------------------------------
const numOrNull = (v) => (v != null && v !== "" ? Number(v) : null);
const strOrNull = (v) => { const s = String(v ?? "").trim(); return s ? s.slice(0, 80) : null; };

app.get("/api/rules", core.requireSession, async (req, res) => {
  res.json({ rules: await db.q(`SELECT * FROM rules WHERE merchant_id=$1 ORDER BY id`, [req.session.merchantId]) });
});
app.post("/api/rules", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || "").trim().slice(0, 40);
  if (!label) return res.status(400).json({ error: "no_label", message: "Rule needs a tag label." });
  const row = await db.one(
    `INSERT INTO rules (merchant_id, label, min_total, max_total, status_is, currency_is, email_contains, name_contains, title_contains, repeat_customer, created_by_id, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.session.merchantId, label,
     numOrNull(b.min_total), numOrNull(b.max_total),
     strOrNull(b.status_is), b.currency_is ? String(b.currency_is).toUpperCase().slice(0, 3) : null,
     strOrNull(b.email_contains), strOrNull(b.name_contains), strOrNull(b.title_contains),
     !!b.repeat_customer, req.actor?.id || null, req.actor?.name || null]);
  res.status(201).json({ rule: row });
});
app.delete("/api/rules/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM rules WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

app.post("/api/rules/apply", core.requireSession, async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 50, 100);
  try {
    const orders = await fetchOrders(req.session, limit);
    const rules = await db.q(`SELECT * FROM rules WHERE merchant_id=$1 ORDER BY id`, [req.session.merchantId]);
    if (!rules.length) return res.json({ scanned: orders.length, tagged: 0, tags_added: 0 });
    const repeatEmails = repeatSet(orders);

    let tagged = 0, added = 0;
    for (const o of orders) {
      const want = matchingLabels(o, rules, repeatEmails).filter((l) => !o.tags.includes(l));
      if (!want.length) continue;
      await writeTagsWith(sessionApi(req.session), req.actor, o.id,
        (cur) => [...new Set([...cur, ...want])],
        want.map((label) => ({ label, action: "auto" })));
      tagged++; added += want.length;
    }
    res.json({ scanned: orders.length, tagged, tags_added: added });
  } catch (err) { res.status(502).json({ error: "apply_failed", message: err?.message }); }
});

// ---- Real-time status + webhook self-registration --------------------------
// Reports whether real-time auto-tagging is live, and lazily registers this
// merchant's webhook (one URL per merchant, with the merchant id in the path so
// the receiver knows the tenant — the payload itself carries no merchant id).
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const hasToken = await tokens.hasToken(mid);
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");

  if (!sub && canRegister) {
    const base = process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
    const url = `${base}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, {
        method: "POST", body: JSON.stringify({ url, event: "orders" }),
      });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2)
                    ON CONFLICT (merchant_id) DO UPDATE SET url=$2, registered_at=now()`, [mid, url]);
      sub = { merchant_id: mid, url };
    } catch (err) {
      // Already-registered (422 unique) is success; record it.
      if (String(err?.message || "").match(/already|unique|exist|422/i)) {
        await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2)
                      ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]);
        sub = { merchant_id: mid, url };
      }
    }
  }
  res.json({
    realtime: Boolean(sub && hasToken),
    webhook_registered: Boolean(sub),
    background_ready: hasToken,
    can_register: Boolean(canRegister),
    webhook_secret_configured: Boolean(WEBHOOK_SECRET),
  });
});

// ---- Webhook receiver ------------------------------------------------------
// POST /webhooks/inkress/:merchantId — Inkress posts order events here. We
// verify the HMAC, dedupe, evaluate the merchant's rules against the payload,
// and PATCH any new tags back using the merchant's background (refresh) token.
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  // Verify signature (Base64 HMAC-SHA256 of the raw body, keyed with our whsec_).
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "bad_signature" });
    }
  }
  // Acknowledge fast (Inkress has a 10s timeout); process asynchronously.
  res.json({ received: true });

  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId) return;

    // Idempotency: skip events we've already handled.
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    const seen = await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid]);
    if (seen) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);

    const rules = await db.q(`SELECT * FROM rules WHERE merchant_id=$1 ORDER BY id`, [merchantId]);
    if (!rules.length) return;

    const order = {
      id: o.id,
      total: Number(o.total || 0),
      currency: (o.currency?.code || o.currency || "JMD"),
      status: String(o.status || "").toLowerCase(),
      title: o.title || o.order_detail?.title || null,
      tags: Array.isArray(o.meta_data?.tags) ? o.meta_data.tags : [],
      lines: (o.lines || []).map((l) => ({ title: l.product_name || l.title, qty: l.quantity, price: l.total })),
      customer: o.customer ? {
        name: [o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email || null,
        email: o.customer.email || null,
      } : null,
    };

    const want = matchingLabels(order, rules, null).filter((l) => !order.tags.includes(l));
    if (!want.length) return;

    const at = await tokens.accessTokenFor(merchantId);
    const bgApi = (p, init) => inkressApi(core.cfg, at, p, init);
    await writeTagsWith(bgApi, { name: "Auto-tag", id: null }, order.id,
      (cur) => [...new Set([...cur, ...want])],
      want.map((label) => ({ label, action: "auto" })));
    console.log(`[order-tagger] auto-tagged order ${order.id} (merchant ${merchantId}): ${want.join(", ")}`);
  } catch (err) {
    console.error(`[order-tagger] webhook processing failed: ${err?.message}`);
  }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[order-tagger] listening on ${HOST}:${PORT}`));

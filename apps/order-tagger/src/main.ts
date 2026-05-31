import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Customer { name: string | null; email: string | null; phone: string | null; }
interface TagLog { label: string; action: string; by: string; at: string; }
interface Order {
  id: number; ref: string; total: number; currency: string; status: string; title: string | null;
  customer: Customer | null; created_at: string | null; tags: string[]; suggested?: string[];
  tag_log: TagLog[]; inkress_url: string; lines?: { title: string; qty: number; price: number }[];
}
interface TopTag { label: string; count: number; }
interface Meta { total: number; tagged: number; untagged: number; suggestions: number; tags: string[]; top_tags: TopTag[]; }
interface Rule {
  id: number; label: string; min_total: string | null; max_total: string | null; status_is: string | null;
  currency_is: string | null; email_contains: string | null; name_contains: string | null;
  title_contains: string | null; repeat_customer: boolean;
}
interface PaletteTag { id: number; label: string; color: string; }
interface Status { realtime: boolean; webhook_registered: boolean; background_ready: boolean; can_register: boolean; webhook_secret_configured: boolean; }

const COLORS = ["slate", "blue", "green", "amber", "red", "purple", "pink", "teal"];

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let filter = "";        // "", "untagged", or a tag label
let statusFilter = "";  // "" or an order status
let search = "";
let palette: Record<string, string> = {};
let selected = new Set<number>();
let shell: ReturnType<typeof mountShell>;

const STATUSES = ["pending", "paid", "confirmed", "prepared", "shipped", "delivered", "completed", "cancelled", "refunded"];

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "tag",
    title: "Order Tagger",
    subtitle: `${merchantName} · label & organise real orders`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "orders", label: "Orders", icon: "list", render: renderOrders },
      { id: "rules", label: "Auto-tag rules", icon: "settings", render: renderRules },
      { id: "palette", label: "Tags", icon: "tag", render: renderPalette },
    ],
  });
})();

/* ----------------------------------------------------------------- chip kit */
function colorOf(label: string): string { return palette[label] || "slate"; }
function chip(label: string, opts: { suggested?: boolean; onRemove?: () => void; onClick?: () => void } = {}) {
  const c = h("span", {
    class: "tg-tag" + (opts.suggested ? " is-suggested" : ""),
    dataset: { color: opts.suggested ? "slate" : colorOf(label) },
    onClick: opts.onClick ? (e: Event) => { e.stopPropagation(); opts.onClick!(); } : undefined,
  }, opts.suggested ? iconEl("plus", 11) : null, label,
    opts.onRemove ? h("button", { class: "tg-tag-x", title: "Remove", onClick: (e: Event) => { e.stopPropagation(); opts.onRemove!(); } }, iconEl("x", 11)) : null);
  return c;
}

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading orders…"));
  let data: { orders: Order[]; meta: Meta; palette: Record<string, string> };
  let status: Status | null = null;
  try {
    [data, status] = await Promise.all([
      bvApi<{ orders: Order[]; meta: Meta; palette: Record<string, string> }>("/api/orders?limit=50"),
      bvApi<Status>("/api/status").catch(() => null as any),
    ]);
  } catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load orders", text: err?.message })); return; }
  palette = data.palette || {};
  host.innerHTML = "";

  // Real-time banner
  if (status) {
    const on = status.realtime;
    host.append(h("div", { class: "tg-realtime" + (on ? " is-on" : "") },
      iconEl(on ? "bell" : "clock", 15),
      h("span", null, on
        ? "Real-time auto-tagging is on — new and updated orders are tagged automatically."
        : "Tag on demand below. Real-time auto-tagging activates once this app is reconnected with webhook access."),
    ));
  }

  host.append(statRow([
    { k: "Recent orders", v: String(data.meta.total), icon: "receipt" },
    { k: "Tagged", v: String(data.meta.tagged), tone: "ok", icon: "tag" },
    { k: "Untagged", v: String(data.meta.untagged), icon: "inbox" },
    { k: "Suggestions", v: String(data.meta.suggestions), tone: "accent", icon: "sparkles" },
  ]));

  if (data.meta.top_tags?.length) {
    host.append(h("div", { class: "tg-toptags" },
      h("span", { class: "bv-muted" }, "Top tags:"),
      ...data.meta.top_tags.map((t) => h("span", { class: "tg-toptag" },
        chip(t.label), h("b", null, String(t.count))))));
  }

  // filter chips: All / Untagged / each tag in use
  const chips = h("div", { class: "tg-filters" },
    filterChip("All", ""),
    filterChip("Untagged", "untagged"),
    ...data.meta.tags.map((t) => filterChip(t, t, true)),
  );
  const statusSel = h("select", { class: "tg-statusfilter", onChange: (e: Event) => { statusFilter = (e.target as HTMLSelectElement).value; rerenderRows(); } },
    h("option", { value: "" }, "Any status"),
    ...STATUSES.map((s) => h("option", { value: s, selected: statusFilter === s }, s))) as HTMLSelectElement;
  const searchInput = h("input", { class: "tg-search", placeholder: "Search ref, customer…", value: search }) as HTMLInputElement;
  let st: any;
  searchInput.addEventListener("input", () => { clearTimeout(st); st = setTimeout(() => { search = searchInput.value; rerenderRows(); }, 200); });

  let rows = applyFilter(data.orders);
  const bulkBar = h("div", { class: "tg-bulkbar" });
  const tableHost = h("div");
  const renderBulk = () => {
    bulkBar.innerHTML = "";
    if (!selected.size) { bulkBar.style.display = "none"; return; }
    bulkBar.style.display = "flex";
    const tagSel = h("select", { class: "tg-bulk-select" },
      h("option", { value: "" }, "Choose a tag…"),
      ...data.meta.tags.map((t) => h("option", { value: t }, t))) as HTMLSelectElement;
    bulkBar.append(
      h("span", { class: "tg-bulk-count" }, `${selected.size} selected`),
      tagSel,
      h("button", { class: "primary sm", onClick: () => bulkTag(tagSel.value, "add") }, iconEl("tag", 14), "Apply"),
      h("button", { class: "ghost sm", onClick: () => bulkTag(tagSel.value, "remove") }, "Remove"),
      h("div", { class: "tg-bulk-spacer" }),
      h("button", { class: "ghost sm", onClick: () => { selected.clear(); rerenderRows(); } }, "Clear"),
    );
  };
  const renderTable = () => {
    tableHost.innerHTML = "";
    tableHost.append(rows.length ? ordersTable(rows, rerenderRows) : emptyState({ icon: "tag", title: "No orders match", text: "Adjust the filter or search." }));
    renderBulk();
  };
  function rerenderRows() { rows = applyFilter(data.orders); renderTable(); }
  renderTable();

  const exportBtn = h("button", { class: "ghost sm", onClick: () => exportCsv(rows) }, iconEl("download", 14), "Export CSV");
  host.append(card({
    title: "Orders",
    action: h("div", { class: "tg-toolbar" }, statusSel, searchInput, exportBtn),
    body: [chips, bulkBar, tableHost],
  }));
}

async function bulkTag(label: string, action: "add" | "remove") {
  if (!label) { toast("Choose a tag first", "warning"); return; }
  const ids = [...selected];
  try {
    const r = await bvApi<{ changed: number }>("/api/orders/bulk/tags", { method: "POST", body: JSON.stringify({ ids, label, action }) });
    flash(`${action === "add" ? "Tagged" : "Untagged"} ${r.changed} order${r.changed === 1 ? "" : "s"}`, "success");
    selected.clear(); shell.select("orders");
  } catch (err: any) { toast(err?.message || "Bulk action failed", "error"); }
}

function exportCsv(rows: Order[]) {
  const head = ["ref", "customer", "email", "total", "currency", "status", "tags", "created_at"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const o of rows) lines.push([o.ref, o.customer?.name || "", o.customer?.email || "", o.total, o.currency, o.status, o.tags.join(" | "), o.created_at || ""].map(esc).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash(`Exported ${rows.length} order${rows.length === 1 ? "" : "s"}`, "success");
}

function applyFilter(orders: Order[]): Order[] {
  const q = search.trim().toLowerCase();
  return orders.filter((o) => {
    if (filter === "untagged" && o.tags.length) return false;
    if (filter && filter !== "untagged" && !o.tags.includes(filter)) return false;
    if (statusFilter && o.status !== statusFilter) return false;
    if (q && !(`${o.ref} ${o.customer?.name ?? ""} ${o.customer?.email ?? ""}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function filterChip(label: string, value: string, colored = false) {
  const on = filter === value;
  return h("button", {
    class: "tg-filter" + (on ? " is-on" : "") + (colored ? " tg-filter-tag" : ""),
    dataset: colored && !on ? { color: colorOf(label) } : {},
    onClick: () => { filter = value; selected.clear(); shell.select("orders"); },
  }, label);
}

function ordersTable(rows: Order[], rerender: () => void) {
  const allSelected = rows.length > 0 && rows.every((o) => selected.has(o.id));
  return dataTable<Order>({
    columns: [
      {
        head: "", cell: (o) => {
          const cb = h("input", { type: "checkbox", class: "tg-check-row", checked: selected.has(o.id), onClick: (e: Event) => e.stopPropagation() }) as HTMLInputElement;
          cb.addEventListener("change", () => { if (cb.checked) selected.add(o.id); else selected.delete(o.id); rerender(); });
          return cb;
        },
      },
      { head: "Order", cell: (o) => h("div", null,
          h("strong", null, `#${o.ref}`),
          h("div", { class: "bv-muted" }, o.customer?.name || o.customer?.email || "—")) },
      { head: "Total", num: true, cell: (o) => fmtMoney(o.total, o.currency) },
      { head: "Status", cell: (o) => pill(o.status, o.status === "paid" || o.status === "completed" ? "ok" : o.status === "cancelled" || o.status === "refunded" ? "bad" : undefined) },
      { head: "Tags", cell: (o) => tagCell(o) },
      { head: "When", cell: (o) => h("span", { class: "bv-muted" }, o.created_at ? relTime(o.created_at) : "—") },
    ],
    rows,
    onRowClick: (o) => openOrder(o.id),
  });
}

function tagCell(o: Order) {
  const wrap = h("div", { class: "tg-tags", onClick: (e: Event) => e.stopPropagation() });
  for (const t of o.tags) wrap.append(chip(t, { onRemove: () => removeTag(o.id, t) }));
  for (const s of o.suggested || []) wrap.append(chip(s, { suggested: true, onClick: () => addTag(o.id, s) }));
  wrap.append(h("button", { class: "tg-tag-add", title: "Add tag", onClick: () => promptAddTag(o.id) }, iconEl("plus", 12)));
  return wrap;
}

async function addTag(id: number, label: string) {
  try { await bvApi(`/api/orders/${id}/tags`, { method: "POST", body: JSON.stringify({ label }) }); flash(`Tagged “${label}”`, "success"); shell.select("orders"); }
  catch (err: any) { toast(err?.message || "Couldn't tag", "error"); }
}
async function removeTag(id: number, label: string) {
  try { await bvApi(`/api/orders/${id}/tags/${encodeURIComponent(label)}`, { method: "DELETE" }); flash(`Removed “${label}”`, "info"); shell.select("orders"); }
  catch (err: any) { toast(err?.message || "Couldn't remove", "error"); }
}
function promptAddTag(id: number) {
  const input = h("input", { placeholder: "e.g. VIP, wholesale, fraud-check", autofocus: true }) as HTMLInputElement;
  const known = Object.keys(palette);
  const body = h("div", null,
    h("label", { class: "bv-label" }, "Tag label"), input,
    known.length ? h("div", { class: "tg-quick" }, ...known.map((q) => chip(q, { onClick: () => { input.value = q; } }))) : null);
  openModal({
    title: "Add a tag", body,
    actions: [{ label: "Add tag", primary: true, onClick: () => { const v = input.value.trim(); if (v) addTag(id, v); } }],
  });
}

async function openOrder(id: number) {
  let order: Order;
  try { order = (await bvApi<{ order: Order }>(`/api/orders/${id}`)).order; }
  catch (err: any) { toast(err?.message || "Couldn't load order", "error"); return; }

  const tagsHost = h("div", { class: "tg-tags" });
  const paintTags = () => {
    tagsHost.innerHTML = "";
    if (!order.tags.length) tagsHost.append(h("span", { class: "bv-muted" }, "No tags yet."));
    for (const t of order.tags) tagsHost.append(chip(t, { onRemove: async () => { await detailRemove(order, t); paintTags(); } }));
    tagsHost.append(h("button", { class: "tg-tag-add", onClick: () => detailAdd(order, paintTags) }, iconEl("plus", 12)));
  };
  paintTags();

  const lines = (order.lines && order.lines.length)
    ? h("table", { class: "bv-table tg-lines" }, h("tbody", null,
        ...order.lines.map((l) => h("tr", null, h("td", null, `${l.qty}× ${l.title}`), h("td", { class: "num" }, fmtMoney(l.price * l.qty, order.currency)))),
        h("tr", { class: "tg-lines-total" }, h("td", null, h("b", null, "Total")), h("td", { class: "num" }, h("b", null, fmtMoney(order.total, order.currency))))))
    : h("div", { class: "bv-muted" }, `Total ${fmtMoney(order.total, order.currency)}`);

  const history = order.tag_log.length
    ? h("div", { class: "tg-history" }, ...order.tag_log.slice().reverse().map((e) =>
        h("div", { class: "tg-history-row" },
          pill(e.action, e.action === "remove" ? "bad" : e.action === "auto" ? "accent" : "ok"),
          h("span", null, h("b", null, e.label)),
          h("span", { class: "bv-muted" }, `${e.by} · ${e.at ? fmtDate(e.at, true) : ""}`))))
    : h("div", { class: "bv-muted" }, "No tag history yet.");

  const body = h("div", { class: "tg-detail" },
    h("div", { class: "tg-detail-head" },
      h("div", null,
        order.customer ? h("strong", null, order.customer.name || order.customer.email || `#${order.ref}`) : h("strong", null, `#${order.ref}`),
        order.customer?.email ? h("div", { class: "bv-muted" }, order.customer.email) : null,
        h("div", { class: "bv-muted" }, `#${order.ref} · `, pill(order.status, order.status === "paid" ? "ok" : undefined))),
      h("a", { class: "tg-link", href: order.inkress_url, target: "_blank", rel: "noopener" }, iconEl("external", 14), "Open in Inkress")),
    lines,
    h("div", { class: "bv-label", style: { marginTop: "14px" } }, "Tags"), tagsHost,
    h("div", { class: "bv-label", style: { marginTop: "16px" } }, "History"), history,
  );
  openModal({ title: `Order #${order.ref}`, body, actions: [{ label: "Done", onClick: () => { shell.select("orders"); } }] });
}

async function detailAdd(order: Order, repaint: () => void) {
  const input = h("input", { placeholder: "e.g. VIP", autofocus: true }) as HTMLInputElement;
  const known = Object.keys(palette);
  const doAdd = async (v: string) => {
    if (!v) return;
    try { const r = await bvApi<{ tags: string[]; tag_log: TagLog[] }>(`/api/orders/${order.id}/tags`, { method: "POST", body: JSON.stringify({ label: v }) }); order.tags = r.tags; order.tag_log = r.tag_log; repaint(); flash("Tagged", "success"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({
    title: "Add a tag",
    body: h("div", null, h("label", { class: "bv-label" }, "Tag label"), input,
      known.length ? h("div", { class: "tg-quick" }, ...known.map((q) => chip(q, { onClick: () => { input.value = q; } }))) : null),
    actions: [{ label: "Add", primary: true, onClick: () => { void doAdd(input.value.trim()); } }],
  });
}
async function detailRemove(order: Order, label: string) {
  try { const r = await bvApi<{ tags: string[]; tag_log: TagLog[] }>(`/api/orders/${order.id}/tags/${encodeURIComponent(label)}`, { method: "DELETE" }); order.tags = r.tags; order.tag_log = r.tag_log; }
  catch (err: any) { toast(err?.message || "error", "error"); }
}

/* --------------------------------------------------------------------- Rules */
async function renderRules(host: HTMLElement) {
  let rules: Rule[] = [];
  try { rules = (await bvApi<{ rules: Rule[] }>("/api/rules")).rules; }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load rules", text: err?.message })); return; }

  const list = rules.length
    ? dataTable<Rule>({
        columns: [
          { head: "Tag", cell: (r) => chip(r.label) },
          { head: "When", cell: (r) => h("span", { class: "bv-muted" }, ruleSummary(r)) },
        ],
        rows: rules,
        rowActions: (r) => h("button", { class: "ghost sm", onClick: async () => { await bvApi(`/api/rules/${r.id}`, { method: "DELETE" }); flash("Rule deleted", "info"); shell.select("rules"); } }, iconEl("trash", 14)),
      })
    : emptyState({ icon: "settings", title: "No auto-tag rules yet", text: "Add a rule to tag matching orders automatically." });

  const apply = h("button", { class: "primary", onClick: async () => {
    try { const r = await bvApi<{ scanned: number; tagged: number; tags_added: number }>("/api/rules/apply", { method: "POST", body: JSON.stringify({ limit: 50 }) });
      flash(`Scanned ${r.scanned} orders · tagged ${r.tagged} · ${r.tags_added} tags added`, "success"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  } }, iconEl("sparkles", 16), "Apply rules to recent orders");

  host.append(
    card({ title: "Auto-tag rules", action: rules.length ? apply : undefined, body: list }),
    card({ title: "New rule", body: ruleForm() }),
  );
}

function ruleSummary(r: Rule): string {
  const parts: string[] = [];
  if (r.min_total != null) parts.push(`total ≥ ${fmtMoney(Number(r.min_total), currency)}`);
  if (r.max_total != null) parts.push(`total ≤ ${fmtMoney(Number(r.max_total), currency)}`);
  if (r.status_is) parts.push(`status is ${r.status_is}`);
  if (r.currency_is) parts.push(`currency ${r.currency_is}`);
  if (r.email_contains) parts.push(`email has “${r.email_contains}”`);
  if (r.name_contains) parts.push(`name has “${r.name_contains}”`);
  if (r.title_contains) parts.push(`item/title has “${r.title_contains}”`);
  if (r.repeat_customer) parts.push("repeat customer");
  return parts.length ? parts.join(" · ") : "every order";
}

function ruleForm() {
  const label = h("input", { placeholder: "Tag to apply, e.g. VIP" }) as HTMLInputElement;
  const minTotal = h("input", { type: "number", placeholder: "e.g. 10000", min: "0" }) as HTMLInputElement;
  const maxTotal = h("input", { type: "number", placeholder: "no max", min: "0" }) as HTMLInputElement;
  const status = h("select", null, h("option", { value: "" }, "Any status"), ...STATUSES.map((s) => h("option", { value: s }, s))) as HTMLSelectElement;
  const cur = h("input", { placeholder: "e.g. JMD", maxlength: "3" }) as HTMLInputElement;
  const emailC = h("input", { placeholder: "e.g. @acme.com" }) as HTMLInputElement;
  const nameC = h("input", { placeholder: "e.g. Ltd" }) as HTMLInputElement;
  const titleC = h("input", { placeholder: "e.g. Colour" }) as HTMLInputElement;
  const repeat = h("input", { type: "checkbox" }) as HTMLInputElement;

  const submit = h("button", { class: "primary", onClick: async () => {
    if (!label.value.trim()) { toast("Enter a tag label", "warning"); return; }
    try {
      await bvApi("/api/rules", { method: "POST", body: JSON.stringify({
        label: label.value.trim(),
        min_total: minTotal.value || null,
        max_total: maxTotal.value || null,
        status_is: status.value || null,
        currency_is: cur.value.trim().toUpperCase() || null,
        email_contains: emailC.value.trim() || null,
        name_contains: nameC.value.trim() || null,
        title_contains: titleC.value.trim() || null,
        repeat_customer: repeat.checked,
      }) });
      flash("Rule added", "success"); shell.select("rules");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  } }, "Add rule");

  return h("div", { class: "tg-ruleform" },
    h("div", { class: "tg-ruleform-grid" },
      labeled("Apply tag", label),
      labeled("Order status", status),
      labeled("Min total", minTotal),
      labeled("Max total", maxTotal),
      labeled("Currency", cur),
      labeled("Customer email contains", emailC),
      labeled("Customer name contains", nameC),
      labeled("Item / title contains", titleC)),
    h("label", { class: "tg-check" }, repeat, " Only repeat customers (2+ orders in the recent window)"),
    h("div", { style: { marginTop: "12px" } }, submit));
}

/* ------------------------------------------------------------------- Palette */
async function renderPalette(host: HTMLElement) {
  let tags: PaletteTag[] = [];
  try { tags = (await bvApi<{ tags: PaletteTag[] }>("/api/tags")).tags; }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load tags", text: err?.message })); return; }
  palette = Object.fromEntries(tags.map((t) => [t.label, t.color]));

  const list = tags.length
    ? h("div", { class: "tg-palette-list" }, ...tags.map((t) => h("div", { class: "tg-palette-row" },
        h("span", { class: "tg-tag", dataset: { color: t.color } }, t.label),
        h("div", { class: "tg-swatches" }, ...COLORS.map((c) => h("button", {
          class: "tg-swatch" + (c === t.color ? " is-on" : ""), dataset: { color: c }, title: c,
          onClick: async () => { try { await bvApi(`/api/tags/${t.id}`, { method: "PATCH", body: JSON.stringify({ color: c }) }); shell.select("palette"); } catch (err: any) { toast(err?.message || "error", "error"); } },
        }))),
        h("button", { class: "ghost sm", title: "Delete tag", onClick: async () => { await bvApi(`/api/tags/${t.id}`, { method: "DELETE" }); flash("Tag removed", "info"); shell.select("palette"); } }, iconEl("trash", 14)))))
    : emptyState({ icon: "tag", title: "No saved tags yet", text: "Create named, colour-coded tags so they look consistent everywhere." });

  // Add form
  const nameInput = h("input", { placeholder: "Tag name, e.g. VIP" }) as HTMLInputElement;
  let chosen = "blue";
  const swatches = h("div", { class: "tg-swatches" }, ...COLORS.map((c) => {
    const b = h("button", { class: "tg-swatch" + (c === chosen ? " is-on" : ""), dataset: { color: c }, title: c,
      onClick: () => { chosen = c; swatches.querySelectorAll(".tg-swatch").forEach((el) => el.classList.toggle("is-on", (el as HTMLElement).dataset.color === c)); } });
    return b;
  }));
  const add = h("button", { class: "primary", onClick: async () => {
    const v = nameInput.value.trim(); if (!v) { toast("Enter a tag name", "warning"); return; }
    try { await bvApi("/api/tags", { method: "POST", body: JSON.stringify({ label: v, color: chosen }) }); flash("Tag saved", "success"); shell.select("palette"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  } }, "Save tag");

  host.append(
    card({ title: "Your tags", body: list }),
    card({ title: "New tag", body: h("div", { class: "tg-newtag" },
      labeled("Name", nameInput),
      h("div", { class: "tg-field" }, h("span", { class: "bv-label" }, "Colour"), swatches),
      h("div", { style: { marginTop: "12px" } }, add)) }),
  );
}

/* -------------------------------------------------------------------- helpers */
function labeled(label: string, el: HTMLElement) {
  return h("label", { class: "tg-field" }, h("span", { class: "bv-label" }, label), el);
}
function fatal(msg?: string) {
  return h("div", { class: "bv-empty", style: { margin: "40px auto" } },
    h("h3", null, "Order Tagger couldn't load"),
    h("p", null, msg || "Open this app from the Inkress dashboard."));
}

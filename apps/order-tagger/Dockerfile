# Multi-stage build for Phone Order Taker.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/order-tagger ./apps/order-tagger
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/order-tagger
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/order-tagger/package.json ./apps/order-tagger/package.json
COPY --from=builder /work/apps/order-tagger/node_modules ./apps/order-tagger/node_modules
COPY --from=builder /work/apps/order-tagger/dist ./apps/order-tagger/dist
COPY apps/order-tagger/server.js ./apps/order-tagger/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/order-tagger
CMD ["node", "--import", "@opentelemetry/auto-instrumentations-node/register", "server.js"]

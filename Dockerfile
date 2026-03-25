FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && \
    npm rebuild better-sqlite3

COPY . .
RUN npm run build

# --- Production image ---
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist
COPY .claude-plugin .claude-plugin
COPY .mcp.json.template .mcp.json.template
COPY hooks/hooks.json.template hooks/hooks.json.template

# Disable daemon (requires Unix socket), embeddings (downloads ~80MB model),
# and reranker — BM25-only mode starts instantly.
ENV M9K_NO_DAEMON=1
ENV M9K_EMBEDDINGS=false
ENV M9K_RERANKER=false

ENTRYPOINT ["node", "dist/server.js"]

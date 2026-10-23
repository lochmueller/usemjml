# syntax=docker/dockerfile:1

ARG NODE_VERSION=26-alpine
ARG ALPINE_VERSION=3.24

# ---------------------------------------------------------------------------
# Dependencies — all pure JavaScript, so they are installed once on the build
# platform even when cross-building for another architecture.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && find node_modules \
      \( -name '*.md' -o -name '*.map' -o -name '.github' -o -name 'test' -o -name '__tests__' \) \
      -prune -exec rm -rf {} +

# ---------------------------------------------------------------------------
# The node binary for the target platform — nothing else of the node image is
# kept, which leaves npm and corepack (~18 MB) out of the final image.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS nodebin

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS runtime

LABEL org.opencontainers.image.title="mjml-server" \
      org.opencontainers.image.description="HTTP API to render and validate MJML, with optional Basic Auth" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MJML_INCLUDE_DIR=/var/lib/mjml/includes

# libstdc++ is the only shared library the node binary needs on musl.
# The include directory is where mj-include partials can be mounted read only.
RUN apk add --no-cache libstdc++ \
 && addgroup -g 1000 -S node \
 && adduser -u 1000 -S -G node node \
 && mkdir -p "${MJML_INCLUDE_DIR}"

COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]

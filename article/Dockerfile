# Shared application runtime; production is the default final target.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime

LABEL org.opencontainers.image.title="neumachen-article-pipeline" \
      org.opencontainers.image.description="Containerised GitHub to Ghost article publication pipeline for neumachen.dev" \
      org.opencontainers.image.source="https://github.com/neumachen/ghost-article-pipeline"

# Git reads committed articles; unzip inspects GitHub artifacts. Apply available
# Debian security updates when rebuilding the pinned base, without recommended tools.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates git unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY src/ src/

# Source and dependencies remain root-owned and readable, not writable by the
# application. The launcher maps the invoking non-root UID/GID onto host mounts.
ENV NODE_ENV=production HOME=/tmp
USER 1000:1000

FROM runtime AS test
LABEL dev.neumachen.article.target="test"
USER 0:0
COPY test/ test/
# Foreign-owned Git fixtures are built here, never by a privileged test runner.
RUN node test/ownership-evidence.mjs --prepare
USER 1000:1000

FROM runtime AS production
LABEL dev.neumachen.article.target="production"

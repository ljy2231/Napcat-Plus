# The pinned runtime supplies Linux QQ 3.2.34-53644 and native runtime libraries.
ARG QQ_RUNTIME=mlikiowa/napcat-docker@sha256:696e9574a0f6fb2f86cbecba8a32048f2a5823117dc9b13c6c02637ad890fa8b
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
ARG CONSOLE_VERSION=0.1.0
ENV NAPCAT_VERSION=4.18.42+console.${CONSOLE_VERSION}
RUN pnpm run typecheck && pnpm --filter napcat-test exec vitest run
RUN pnpm run build:webui && pnpm run build:shell && pnpm run build:plugin-builtin

FROM ${QQ_RUNTIME}
LABEL org.opencontainers.image.title="QQ Bot Console" \
      org.opencontainers.image.source="https://github.com/ljy2231/qq-bot-console"
COPY --from=build /src/packages/napcat-shell/dist/ /app/napcat/
COPY deploy/prepare-runtime.py /usr/local/share/qq-bot-console/prepare-runtime.py
RUN python3 /usr/local/share/qq-bot-console/prepare-runtime.py
ENV QQ_BOT_CONSOLE_PINNED=1
EXPOSE 6099 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6099/webui/ >/dev/null || exit 1

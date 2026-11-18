# The pinned runtime supplies Linux QQ 3.2.34-53644 and native runtime libraries.
# The upstream mlikiowa/napcat-docker image was removed with the NapCat source
# shutdown, so the pinned runtime is republished under this repository's GHCR.
ARG QQ_RUNTIME=ghcr.io/ljy2231/napcat-plus-base:qq-3.2.34-53644@sha256:6c1b1a2736588060f484ea273a190309bdeca32c15d6a9c61325d3499ee091fa
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
ARG CONSOLE_VERSION=0.5.1
ENV NAPCAT_VERSION=4.18.42+napcat-plus.${CONSOLE_VERSION}
RUN pnpm run typecheck && pnpm --filter napcat-test exec vitest run
RUN pnpm run build:webui && pnpm run build:shell && pnpm run build:plugin-builtin

FROM ${QQ_RUNTIME}
ARG CONSOLE_VERSION=0.5.1
LABEL org.opencontainers.image.title="Napcat-Plus" \
      org.opencontainers.image.source="https://github.com/ljy2231/Napcat-Plus"
COPY --from=build /src/packages/napcat-shell/dist/ /app/napcat/
COPY deploy/prepare-runtime.py /usr/local/share/napcat-plus/prepare-runtime.py
RUN python3 /usr/local/share/napcat-plus/prepare-runtime.py
ENV NAPCAT_PLUS_PINNED=1 \
    NAPCAT_PLUS_VERSION=${CONSOLE_VERSION}
EXPOSE 6099 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6099/webui/ >/dev/null || exit 1

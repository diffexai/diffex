# Toolchain only: no repository COPY, release artifacts, credentials, or agent config.
FROM node:22.23.2-bookworm-slim

ARG BUN_VERSION=1.3.11
ARG NPM_VERSION=11.16.0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 tmux ripgrep fd-find git \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && npm install --global --ignore-scripts npm@${NPM_VERSION} \
    && test "$(node --version)" = "v22.23.2" \
    && test "$(npm --version)" = "${NPM_VERSION}"
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl --fail --silent --show-error --location \
       "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /tmp/bun \
    && install /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && test "$(bun --version)" = "${BUN_VERSION}" \
    && python3 --version && tmux -V && rg --version && fd --version
WORKDIR /tmp

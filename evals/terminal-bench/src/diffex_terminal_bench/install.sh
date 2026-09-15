#!/usr/bin/env bash
set -euo pipefail
umask 022

exec > >(tee "$SETUP_LOGS/install.stdout.log")
exec 2> >(tee "$SETUP_LOGS/install.stderr.log" >&2)
export SETUP_STARTED_AT
SETUP_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SECONDS=0
prefix=/opt/diffex-terminal-bench
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)

if [ "$(uname -s)" != Linux ] || ! command -v apt-get >/dev/null; then
    echo "Setup requires Debian/Ubuntu Linux with glibc and root access" >&2
    exit 1
fi
case "$(uname -m)" in
    x86_64) arch=x64; checksum=$NODE_SHA256_X64 ;;
    aarch64) arch=arm64; checksum=$NODE_SHA256_ARM64 ;;
    *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac
export NODE_ARCH="$arch" NODE_SHA256="$checksum"

# Refuse to reuse an earlier install or overwrite a task-provided command.
mkdir "$prefix"
if [ -e /usr/local/bin/diffex ] || [ -L /usr/local/bin/diffex ]; then
    echo "A task-provided /usr/local/bin/diffex already exists" >&2
    exit 1
fi
mkdir -p "$HOME" "$prefix/node" "$prefix/cli" "$prefix/work"
cd "$prefix/work"
apt-get -o Acquire::Retries=3 -o Acquire::http::No-Cache=true update
apt-get -o Acquire::Retries=3 -o Acquire::http::No-Cache=true \
    install -y --no-install-recommends ca-certificates wget xz-utils
archive="node-v$NODE_VERSION-linux-$arch.tar.xz"
wget --https-only --tries=3 --timeout=20 --output-document="$archive" \
    "https://nodejs.org/dist/v$NODE_VERSION/$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
tar -xJf "$archive" -C "$prefix/node" --strip-components=1
rm "$archive"
export PATH="$prefix/node/bin:$PATH"
test "$(node --version)" = "v$NODE_VERSION"

touch "$prefix/npm-user.npmrc" "$prefix/npm-global.npmrc"
export NPM_CONFIG_USERCONFIG="$prefix/npm-user.npmrc"
export NPM_CONFIG_GLOBALCONFIG="$prefix/npm-global.npmrc"
export NPM_CONFIG_CACHE="$prefix/npm-cache"
export NPM_CONFIG_REGISTRY="$NPM_REGISTRY" NPM_CONFIG_IGNORE_SCRIPTS=true
npm view "@diffexai/diffex@$DIFFEX_VERSION" version dist engines \
    --registry="$NPM_REGISTRY" --json > "$SETUP_LOGS/npm-metadata.json"
node "$script_dir/verify-install.cjs" metadata
npm install --prefix "$prefix/cli" --ignore-scripts --save-exact \
    --no-audit --no-fund --registry="$NPM_REGISTRY" "@diffexai/diffex@$DIFFEX_VERSION"
node "$script_dir/verify-install.cjs" installed
cp "$prefix/cli/package-lock.json" "$SETUP_LOGS/npm-install-lock.json"

cat > /usr/local/bin/diffex <<'WRAPPER'
#!/bin/sh
exec /opt/diffex-terminal-bench/node/bin/node /opt/diffex-terminal-bench/cli/node_modules/@diffexai/diffex/dist/cli.js "$@"
WRAPPER
chmod 755 /usr/local/bin/diffex
export DIFFEX_CODING_AGENT_DIR="$prefix/smoke-state"
cd /tmp
for flag in version help list-models; do
    diffex "--$flag" </dev/null > "$SETUP_LOGS/$flag.stdout.txt" 2> "$SETUP_LOGS/$flag.stderr.txt"
    test -s "$SETUP_LOGS/$flag.stdout.txt"
done
export SETUP_ELAPSED_SEC="$SECONDS"
node "$script_dir/verify-install.cjs" complete

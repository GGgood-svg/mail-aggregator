#!/bin/sh
set -eu
# Run on a clean Alpine 3.24 x86_64 runner with Node 24 and npm build dependencies.
# The temporary tree is outside the checkout. Only explicit runtime files ship.
[ "$#" -eq 5 ] || { echo "usage: $0 OUT TAG COMMIT FROM_VERSIONS POLICY" >&2; exit 2; }
out=$(cd "$1" && pwd)
project=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
grep -Eq '^3\.24(\.|$)' /etc/alpine-release
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R "$project/server" "$project/web" "$project/config" "$project/package.json" "$project/package-lock.json" "$project/TESTING.md" "$stage/"
mkdir -p "$stage/scripts/lib"
cp "$project/scripts/doctor.sh" "$project/scripts/backup.sh" "$project/scripts/restore.sh" "$project/scripts/verify-backup.sh" "$project/scripts/uninstall.sh" "$stage/scripts/"
cp "$project/scripts/lib/maintenance.sh" "$stage/scripts/lib/"
mkdir "$stage/scripts/updater"
for module in history lock policy release rpc transaction; do
    cp "$project/scripts/updater/$module.js" "$stage/scripts/updater/"
done
cd "$stage"
npm_config_nodedir=/usr npm_config_build_from_source=true npm ci --omit=dev --no-audit --no-fund
node -e 'new (require("better-sqlite3"))(":memory:").close()'
rm -rf "$stage/node_modules/.bin"
# The native build uses hard links to the same compiled objects. Store each
# entry as a regular file so the privileged unpacker need not resolve links.
[ -z "$(find server web config scripts node_modules -type l -print -quit)" ] || exit 1
tar --hard-dereference --format=ustar -czf "$out/mail-aggregator-alpine-3.24-x64-node24.tar.gz" server web config scripts node_modules package.json package-lock.json TESTING.md
node "$project/scripts/updater/build-release.js" manifest "$out" "$stage" "$2" "$3" "$4" "$5"
node "$project/scripts/updater/build-release.js" validate "$out" "$stage/readback"
# Exercise both the native binding and the Web update module in the unpacked,
# self-contained runtime tree; neither check may resolve files from the checkout.
(cd "$stage/readback" && node -e '
  new (require("./node_modules/better-sqlite3"))(":memory:").close();
  if (typeof require("./server/app-update").appUpdate !== "function") process.exit(1);
')

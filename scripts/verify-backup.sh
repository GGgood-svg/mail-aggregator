#!/bin/sh
# Read-only verification for Web backups. Does not extract or restore any file.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(dirname "$SCRIPT_DIR")

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "用法: $0 <backup.tar.gz> [backup.tar.gz.sha256]" >&2
  exit 1
fi

exec node "$APP_DIR/server/cli-verify-backup.js" "$@"

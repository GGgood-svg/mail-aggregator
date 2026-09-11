#!/bin/sh
# Generate the same manifest-verified format as the Web backup center. SQLite
# is copied through its online backup API, never by copying a live DB/WAL pair.
set -eu

DATA_DIR="${MAIL_AGG_DATA_DIR:-/var/lib/mail-aggregator}"
BACKUP_DIR="${1:-/root/mail-aggregator-backups}"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
umask 077

MAIL_AGG_DATA_DIR="$DATA_DIR" node "$PROJECT_ROOT/server/cli-backup.js" "$BACKUP_DIR"

#!/usr/bin/env bash
# Fingerprint the REAL Local Mail data dir's durable state, to prove a write test
# never touched it. Hashes only the durable files: `credentials.json` and every
# account's mailbox, `mail.db`. The volatile `-wal`/`-shm`/`lock.db` sidecars are
# skipped on purpose: SQLite rewrites them during any open, so they are noise,
# not signal.
#
# Usage:
#   fingerprint.sh > before.txt      # capture before a write test
#   ...run the harness / smoke...
#   diff before.txt <(fingerprint.sh)  # must be empty
#
# Env overrides:
#   LOCAL_MAIL_REAL_DIR   data dir to hash (default: macOS Application Support dir)
set -euo pipefail

REAL="${LOCAL_MAIL_REAL_DIR:-$HOME/Library/Application Support/local-mail}"

if [ ! -d "$REAL" ]; then
	echo "error: real data dir not found at: $REAL" >&2
	exit 1
fi

# Sorted for a stable diff regardless of filesystem enumeration order.
{
	[ -f "$REAL/credentials.json" ] && shasum -a 256 "$REAL/credentials.json"
	find "$REAL" -maxdepth 2 -name 'mail.db' -exec shasum -a 256 {} \;
} | sort

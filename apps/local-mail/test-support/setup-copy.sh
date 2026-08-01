#!/usr/bin/env bash
# Create a throwaway copy of the real Local Mail mirror with FORGED dummy
# credentials, so the write harness can never contact real Google and never
# mutates the real mirror.
#
# Why forged creds are safe: the token manager only refreshes when the access
# token is near expiry (see src/token-manager.ts + src/tokens.ts). We stamp the
# copy's expiry far in the future, so `up` reuses the dummy bearer forever and
# never hits Google's token endpoint. The mock ignores the bearer anyway.
#
# Env overrides (all optional):
#   LOCAL_MAIL_REAL_DIR   source mirror (default: macOS Application Support dir)
#   LM_TEST_DIR           throwaway copy destination (default: /tmp/local-mail-harness)
#   LOCAL_MAIL_ACCOUNT    account email to forge (default: the sole account found)
#
# Prints machine-readable lines the other scripts parse:
#   ACCOUNT <email>
#   COPY_READY <dir>
#   MOCK_DB <path to the copied mailbox>
set -euo pipefail

REAL="${LOCAL_MAIL_REAL_DIR:-$HOME/Library/Application Support/local-mail}"
COPY="${LM_TEST_DIR:-/tmp/local-mail-harness}"

if [ ! -d "$REAL" ]; then
	echo "error: real mirror not found at: $REAL" >&2
	echo "Connect an account with 'local-mail connect' first, or set LOCAL_MAIL_REAL_DIR." >&2
	exit 1
fi

# One account, one mailbox, one name: `<accountDir>/mail.db` (ADR-0198). There is
# no version to pick and no predecessor to skip past, so "does this directory hold
# a mailbox" is a single existence check.
mailbox_of() {
	[ -f "$1/mail.db" ] && echo "$1/mail.db"
}

# Resolve the account: an explicit override, else the sole subdir holding a mailbox.
if [ -n "${LOCAL_MAIL_ACCOUNT:-}" ]; then
	ACCT="$LOCAL_MAIL_ACCOUNT"
else
	ACCTS=()
	while IFS= read -r dir; do
		if [ -n "$(mailbox_of "$dir")" ]; then
			ACCTS+=("$dir")
		fi
	done < <(find "$REAL" -maxdepth 1 -mindepth 1 -type d)
	if [ "${#ACCTS[@]}" -eq 0 ]; then
		echo "error: no mail.db found under $REAL" >&2
		exit 1
	fi
	if [ "${#ACCTS[@]}" -gt 1 ]; then
		echo "error: multiple accounts found; set LOCAL_MAIL_ACCOUNT to one of:" >&2
		for d in "${ACCTS[@]}"; do basename "$d" >&2; done
		exit 1
	fi
	ACCT="$(basename "${ACCTS[0]}")"
fi

MAILBOX="$(mailbox_of "$REAL/$ACCT")"
if [ -z "$MAILBOX" ]; then
	echo "error: no mailbox for account '$ACCT' under $REAL" >&2
	exit 1
fi

rm -rf "$COPY"
cp -R "$REAL" "$COPY"
# Drop any copied lock so `up` can acquire its own, plus stray journals/artifacts.
rm -f "$COPY/$ACCT/lock.db" "$COPY/$ACCT/lock.db-journal" "$COPY/.DS_Store" || true

# Forge credentials.json: dummy access+refresh tokens, expiry far in the future.
# Shape mirrors src/token-store.ts: { "<accountEmail>": "<JSON-encoded TokenSet>" }.
cat > "$COPY/credentials.json" <<EOF
{
  "$ACCT": "{\"accountEmail\":\"$ACCT\",\"clientIdUsed\":\"mock-client\",\"environment\":\"dev\",\"accessToken\":\"mock-access-token\",\"refreshToken\":\"mock-refresh-token\",\"accessTokenExpiresAt\":\"2099-01-01T00:00:00.000Z\",\"obtainedAt\":\"2026-01-01T00:00:00.000Z\"}"
}
EOF
chmod 600 "$COPY/credentials.json"

echo "ACCOUNT $ACCT"
echo "COPY_READY $COPY"
echo "MOCK_DB $COPY/$ACCT/$(basename "$MAILBOX")"

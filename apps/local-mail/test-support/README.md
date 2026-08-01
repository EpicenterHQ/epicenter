# Local Mail write-path test support

Local-only harness for exercising Local Mail's Gmail write path (archive, undo,
label, mark read/unread, star) against a **mock Gmail backend** and a
**throwaway copy** of your mirror, so you can verify write UX without ever
touching real Gmail or your real mirror.

This is developer tooling, not `bun test`. The write-path smoke needs a real
connected mirror to copy from; `check-gmail-discovery.ts` makes a live Google
call. Neither is hermetic, so both stay out of the offline suite.

## Gmail API drift check

`check-gmail-discovery.ts` fetches Gmail's Discovery document and asserts that
every method and schema field `src/gmail-client.ts` / `src/schema.ts` rely on is
still present and still the type we expect. Our schemas are deliberately partial
and permissive (they tolerate unknown Gmail fields, and every read field is
optional, so a removed field passes `Value.Check` and reaches a reader as
`undefined`), which is exactly what makes Gmail *removing*, *moving*, or
*retyping* something we depend on invisible until a live sync misbehaves.

The schema-side contract is not re-listed: the check walks the actual `schema.ts`
TypeBox objects (JSON Schema at runtime), so `schema.ts` stays the single source
of the fields we read. The only hand-maintained pieces are the small set of
methods we call (the client builds those paths as string templates, nothing to
derive) and the root-schema name map.

```sh
bun run --cwd apps/local-mail check:gmail-drift
```

It runs weekly (and on demand) via `.github/workflows/local-mail.gmail-drift.yml`,
not per-PR: it is a network call and drift is slow-moving. Exits non-zero listing
each drift.

## Safety model

Four independent guarantees keep this from touching anything real:

1. **A throwaway copy, never the real mirror.** `setup-copy.sh` copies
   `~/Library/Application Support/local-mail` to `LM_TEST_DIR` (default
   `/tmp/local-mail-harness`) and points `local-mail app` at the copy via
   `LOCAL_MAIL_DIR`.
2. **Forged credentials, so no Google contact.** The copy's `credentials.json`
   is rewritten with a dummy access token whose expiry is the year 2099. The
   token manager only refreshes near expiry (`src/token-manager.ts`), so `up`
   reuses the dummy bearer forever and never calls Google's token endpoint.
3. **A local mock, not `gmail.googleapis.com`.** `LOCAL_MAIL_GMAIL_API_BASE`
   points the client at `mock-gmail.ts` on `127.0.0.1`. The mock services only
   `messages.modify` (logged) and a no-op `history.list`; **every other route
   returns a non-retryable 403**, which the sync engine treats as a hard failure
   rather than a signal to run a FULL pull. So the mock can never wipe even the
   copy.
4. **A fingerprint proof.** `fingerprint.sh` hashes the real data dir's durable
   files (`credentials.json` + every account's `mail.db`); capture it before and
   after and diff to confirm nothing real changed.

## Files

| file               | what it is |
|--------------------|------------|
| `mock-gmail.ts`    | Mock Gmail REST server. Reads the copy's SQLite to know current labels, applies the modify, logs it, 403s everything else. |
| `setup-copy.sh`    | Copies the real data dir to `LM_TEST_DIR` and forges dummy credentials. |
| `fingerprint.sh`   | Hashes the real data dir's durable state, for the before/after safety proof. |
| `boot.ts`          | Shared boot used by `smoke.ts` (and any manual session): stands up copy + mock + `up` on ephemeral ports and hands back the launch coordinates. The one owner of the safety-critical wiring. |
| `smoke.ts`         | Headless one-shot: fires one real write through `/api/messages/modify`, asserts it hit the mock, asserts the real mirror is unchanged. |
| `check-gmail-discovery.ts` | Gmail API drift check: fetches the live Discovery doc and asserts the methods (hand-listed) + schema fields (walked from `schema.ts`) the client relies on are still present and correctly typed. |

Runtime artifacts (the copy, the modify log, server logs) live under
`LM_TEST_DIR`, never inside the repo.

## Automated smoke (no browser)

Proves the full server → mock write path end to end and tears itself down:

```sh
bun run apps/local-mail/test-support/smoke.ts
```

On success it prints `SMOKE PASS`, the mock log line for the write, and confirms
the real mirror fingerprint is unchanged. Exits non-zero on any failure.

## Manual write-UX check (browser)

The affordances the API smoke can't assert (undo toast, keyboard triage, the
"catching up" mirror chip, the shortcuts overlay) are verified by hand. `boot.ts`
exports `bootHarness()`, which stands up the same safe stack (copy + mock + `up`)
and returns a launch URL; call it from a scratch script or the REPL, open the
URL, and poke the SPA. Build the SPA first or the page is blank:

```sh
bun run --cwd apps/local-mail/ui build
```

Watch the writes land:

```sh
tail -f /tmp/local-mail-harness/modify-log.jsonl
```

## Read-only smoke against your real mirror

No copy, no writes; a dead Gmail base no-ops the sync loop and every action
button is disabled:

```sh
bun run --cwd apps/local-mail/ui build
LOCAL_MAIL_READ_ONLY=1 LOCAL_MAIL_GMAIL_API_BASE=http://127.0.0.1:9 \
  LOCAL_MAIL_PORT=4181 bun run apps/local-mail/src/bin.ts app
```

## Proving the real mirror was untouched

```sh
bash apps/local-mail/test-support/fingerprint.sh > /tmp/lm-before.txt
# ...run smoke.ts or a manual bootHarness session...
diff /tmp/lm-before.txt <(bash apps/local-mail/test-support/fingerprint.sh)   # must be empty
```

`smoke.ts` does this automatically. Note the fingerprint covers only durable
files; the read-only smoke above legitimately syncs the real mirror, so run that
one separately from a fingerprint window.

## Environment knobs

| var                   | default | meaning |
|-----------------------|---------|---------|
| `LM_TEST_DIR`         | `/tmp/local-mail-harness` | where the throwaway copy + logs live |
| `LOCAL_MAIL_REAL_DIR` | macOS Application Support dir | the mirror to copy/fingerprint |
| `LOCAL_MAIL_ACCOUNT`  | the sole connected account | which account to forge (required if you have more than one) |

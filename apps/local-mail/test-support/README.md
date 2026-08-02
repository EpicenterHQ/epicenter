# Local Mail write-path test support

Local-only harness for exercising Local Mail's write path end to end (assert a
label, run a reconcile pass, watch the reconciler deliver it) against a **mock
Gmail backend** and a **throwaway copy** of your mirror, so you can verify write
UX without ever touching real Gmail or your real mirror.

The path under test is the one the model describes: a triage act writes an
assertion into `intent.db` and returns, and the account's reconciler is the only
thing that calls Gmail (ADR-0198, ADR-0199). So a passing smoke proves two
things, not one: the assertion was recorded, and the reconciler delivered it.

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
   token manager only refreshes near expiry (`src/token-manager.ts`), so `app`
   reuses the dummy bearer forever and never calls Google's token endpoint.
3. **A local mock, not `gmail.googleapis.com`.** `LOCAL_MAIL_GMAIL_API_BASE`
   points the client at `mock-gmail.ts` on `127.0.0.1`. The mock services only
   `messages.modify` (logged) and a no-op `history.list`; **every other route
   returns a non-retryable 403**, which the reconciler treats as a hard failure
   rather than a signal to run a FULL pull. So the mock can never wipe even the
   copy.

   The cost of that narrowness: `messages.trash` and `untrash` are not mocked, so
   a `TRASH` assertion cannot be smoked here. Trash is the one label whose
   delivery routes to its own Gmail verb (ADR-0199), which is exactly the path
   the harness cannot reach, so verify it against a real account or extend the
   mock rather than assuming an archive smoke covered it.
4. **A fingerprint proof.** `fingerprint.sh` hashes the real data dir's durable
   files (`credentials.json` + every `mail.v<version>.db`, predecessors
   included); capture it before and after and diff to confirm nothing real
   changed.

   **Known gap: the fingerprint does not cover `intent.db`.** ADR-0198 made that
   file the one piece of local state Gmail cannot give back, which makes it the
   file this proof most needs to cover and the only durable one it currently
   omits. Guarantee 1 is what actually protects it (the harness points
   `LOCAL_MAIL_DIR` at the copy, so the real `intent.db` is never opened), but
   until `fingerprint.sh` hashes each account's `intent.db` alongside the mirror
   artifacts, a clean diff proves less than it reads as proving.

## Files

| file               | what it is |
|--------------------|------------|
| `mock-gmail.ts`    | Mock Gmail REST server. Reads the copy's SQLite to know current labels, applies the modify, logs it, 403s everything else. |
| `setup-copy.sh`    | Copies the real mirror to `LM_TEST_DIR` and forges dummy credentials. |
| `fingerprint.sh`   | Hashes the real mirror's durable state, for the before/after safety proof. |
| `boot.ts`          | Shared boot used by `smoke.ts` (and any manual session): stands up copy + mock + `app` on ephemeral ports and hands back the launch coordinates. The one owner of the safety-critical wiring. |
| `smoke.ts`         | Headless one-shot: asserts one label through `/api/accounts/:account/messages/assert`, confirms the read surface already shows it, runs `/api/accounts/:account/reconcile`, asserts the delivery hit the mock, asserts the real mirror is unchanged. |
| `check-gmail-discovery.ts` | Gmail API drift check: fetches the live Discovery doc and asserts the methods (hand-listed) + schema fields (walked from `schema.ts`) the client relies on are still present and correctly typed. |

Runtime artifacts (the copy, the modify log, server logs) live under
`LM_TEST_DIR`, never inside the repo.

## Automated smoke (no browser)

Proves the full assert → reconcile → mock path end to end and tears itself down:

```sh
bun run apps/local-mail/test-support/smoke.ts
```

On success it prints `SMOKE PASS`, the mock log line for the delivery, and
confirms the real mirror fingerprint is unchanged. Exits non-zero on any failure.
The two halves are separately meaningful: the read surface reflecting the label
before the reconcile pass runs is the effective-label overlay working, and the
mock log line is the reconciler being the thing that talked to Gmail.

## Manual write-UX check (browser)

The affordances the API smoke can't assert (undo, keyboard triage, the
"catching up" mirror chip, the pending count and its age, the shortcuts overlay)
are verified by hand. `boot.ts` exports `bootHarness()`, which stands up the same
safe stack (copy + mock + `app`) and returns a launch URL; call it from a scratch
script or the REPL, open the URL, and poke the SPA. Build the SPA first or the
page is blank:

```sh
bun run --cwd apps/local-mail/ui build
```

Watch deliveries land. Nothing appears here until a reconcile pass runs, which is
the point: a click that produces no log line has still been recorded, and the
pending count is where you see it.

```sh
tail -f /tmp/local-mail-harness/modify-log.jsonl
```

## Read-only smoke against your real mirror

No copy, no writes; a dead Gmail base no-ops the reconcile loop and every action
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

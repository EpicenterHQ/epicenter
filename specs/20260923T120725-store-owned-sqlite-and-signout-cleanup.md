# Store-owned SQLite and optional account-download removal

- Status: In Progress
- Date: 2026-09-23
- Decisions: [ADR-0436](../docs/adr/0436-stores-own-local-sqlite-namespaces.md), [ADR-0437](../docs/adr/0437-sign-out-offers-removal-of-downloaded-account-data.md)
- Execution prompt: [implementation handoff](20260923T120725-store-owned-sqlite-and-signout-cleanup.handoff.md)

A store owns the identity and lifetime of its SQLite databases; sign-out ends
account access, and an explicit cleanup choice removes only data proven safe to
discard.

## Implementation boundary

Store-owned SQLite and caller API migration are implemented in ADR-0436. See
[implementation notes](../docs/reports/20260923-store-owned-sqlite.md). Legacy
Local Mail recovery remains unresolved; old files are preserved. The user scoped
this implementation to SQL ownership. Steps 3 and 4 below remain future work and
are not authorization to erase data or add a sign-out checkbox.

The examples and sequence below preserve the original proposal for the remaining
cleanup work. References to the former standalone constructor describe history.

## Developer call sites

Current Local Mail composition, abbreviated:

```ts
const personal = await openPersonal(mailDefinition, { account });
const sqlite = await openSqlite({ id: mailDefinition.id });
// Product composition separately owns both lifetimes.
```

Target account-owned SQL:

```ts
const personal = await openPersonal(mailDefinition, { account });
try {
  const opened = await personal.sqlite.open('local');
  if (opened.error) throw opened.error;
  const database = opened.data;
  // Existing database operations use database.
} finally {
  await personal.close();
}
```

Target device-owned SQL, available without an account:

```ts
const local = await openLocal(definition);
try {
  const opened = await local.sqlite.open('search-index');
  if (opened.error) throw opened.error;
  const database = opened.data;
  // Existing database operations use database.
} finally {
  await local.close();
}
```

These examples illustrate short-lived ownership. A page-root store may live until
runtime replacement under the existing departure policy. A service receives
`personal.sqlite` or `local.sqlite`; it does not select another account or close
the borrowed namespace. `sqlite.delete(name)` explicitly deletes a named database;
it is not the product's downloaded-data cleanup policy.

Local and Personal SQL are separate even with identical definition/database names.
Different authorities or principals never share Personal SQL. Account identity
stays private. Neither SQL writes nor raw SQL databases synchronize automatically.

## Implementation sequence

### 1. Establish the baseline and address inventory

Read current source and callers before editing. This checkout has concurrent
row/body, Yjs, and Capture work. Record task-start diffs and validation outcomes;
do not attribute later failures to baseline without evidence. Do not reset,
stage, or rewrite unrelated changes.

Audit every `openSqlite` caller, existing exports, SQL-only consumers, storage
address encoding, and browser/desktop ownership. Preserve Local's existing
no-account address and use the existing encoding for Personal. Local Mail's old
account-independent files cannot safely be attributed to the current account.
Preserve them. Document a recoverable product transition before claiming migration
complete; do not silently adopt, copy, rename, or delete them. A real SQL-only
consumer is a concrete API judgment point, not permission to invent an empty store.

### 2. Make the store own SQL

Extend the complete store runtime with scoped SQL acquisition and isolated test
bindings. Capture Personal identity before awaits. Acquire SQL with document and
blob resources; return only after all required namespace acquisition succeeds.
Keep named database opening explicit and preserve existing Result contracts.

Expose borrowed `sqlite` with `open` and `delete`. Store close synchronously fences
all children before awaiting any cleanup. Handle late acquisitions, rollback,
repeated close, admitted operations, and failed cleanup without releasing unsafe
ownership. Retain the physical SQL owner's exclusion and operation ordering.
A supplied test runtime cannot fall through to production SQL.

Run an independent adversarial review of the lifecycle and namespace changes.
Then migrate product callers and remove the standalone public constructor once
its real callers are accounted for. Secrets and inference remain independent.

### 3. Prove one cleanup scope

Inventory persisted resources, including unopened databases. Each participating
product must identify downloaded/rebuildable data and evidence that removal loses
no unique work. Local Mail's `local` database contains account metadata and pending
triage; it is not a blanket cache. Per-mailbox databases need their own audit.
A Personal replica with unsent changes is also not automatically disposable.

Build the narrowest cleanup owner that can enumerate, fence, drain, and erase the
chosen account scope. Include other windows and competing opens. Recheck eligibility
after fencing. Unknown or mixed data remains unless safe subset deletion is proven.
Do not open a syncing store merely to erase it, call remote blob deletion, or clear
all browser storage. Keep device-owned Local data and unrelated credentials.

Capture exact authority/principal and cleanup scope before credentials retire.
Choose and verify the host or recovery mechanism that survives document replacement.
Recovery metadata contains no credentials. Cleanup failure cannot block sign-out,
reactivate old handles, or report successful removal. Preserve an honest retryable
outcome. Ordinary unchecked sign-out gains no general resource-drain barrier.

Before wiring UI, adversarially review deletion races, scope coverage, retained
pending work, and recovery. If durable reconstruction evidence is unavailable,
retain that resource and report it; do not infer safety from connectivity.

### 4. Integrate the confirmation flow

Offer the unchecked checkbox at explicit sign-out. Identify the selected account.
Use “from this device” only where the desktop host proves installation-wide
coverage. Browser wording should identify this site's storage; a single-app scope
must name that app. Do not imply cross-origin or whole-device erasure.

Preflight explains any retained pending or uncertain data and offers sign-out
with data retained or cancellation. No silent discard choice is included.
Keep the captured removal intent across browser navigation and desktop departure.
Revocation and removal have separate outcomes; report partial/failed removal and
a retry path. Review shared confirmation and desktop settings together so they
do not promise different behavior. Enable the checkbox only for a proven scope.

## Source map

- `packages/app/src/open-store.ts`: store acquisition, private account snapshot, close.
- `packages/app/src/store-runtime.ts`, `testing.ts`: complete runtime and isolation.
- `packages/app/src/sqlite.ts`: current standalone SQL namespace contract.
- `packages/device/src/owner.ts`: physical ownership, sequencing, deletion.
- `packages/principal/src/device-owner.ts`: existing namespace encoding.
- `apps/local-mail/ui/src/lib/resources.ts`, `apps/local-mail/src/storage.ts`: actual SQL consumer and durable/cache mixture.
- `packages/app-shell/src/boot-screens/confirm-account-change.ts`: confirmation.
- `packages/app-shell/src/boot-screens/app-boot.svelte`: captured account and departure.
- `packages/app-shell/src/account-popover/account-popover.svelte`: sign-out entry.
- `apps/epicenter/src/ui/Settings.svelte`: desktop confirmation copy.
- ADR-0367: exclusive erasure; ADR-0415: runtime replacement; ADR-0429: private identity.

Paths are relative to the repository root. Re-read source: concurrent work can
change signatures and tests while this plan is open.

## Completion evidence

Verify these behaviors with focused tests and the relevant browser/desktop probes:

- Local survives account changes; Alice, Bob, and different authorities isolate SQL.
- Same-scope duplicate ownership and deletion/reopening preserve physical exclusion.
- SQL acquisition failure unwinds other children; child failure unwinds SQL.
- Retained methods fence immediately, late operations settle, close is idempotent,
  and failed cleanup cannot admit an unsafe replacement owner.
- Explicit test runtimes remain isolated from production storage.
- Checked cleanup includes eligible unopened resources and excludes Local, another
  account, remote data, unique pending edits, and unknown databases.
- A write after preflight, another window, account replacement, cancellation,
  interrupted deletion, and cleanup failure cannot bypass exclusion or lose data.
- Unchecked sign-out preserves bytes. Failed cleanup still permits sign-out and
  reports retained data. Recovery never adopts a newly signed-in account.
- Local Mail uses the new namespace with a documented old-data recovery path.

Run package `@epicenter/app` and `@epicenter/device` typechecks and focused tests,
then consumer and app-shell checks affected by the implementation. Inspect current
package scripts rather than assuming old commands remain valid. Use bun. Do not
run dependency upgrades or absorb unrelated body/schema/Capture changes.

Run a cumulative adversarial review after integration. Update current READMEs only
when behavior exists, update ADR implementation metadata with evidence, and delete
this spent spec and its execution handoff. Keep durable decisions in the ADRs.
No runtime tests were run for this documentation-only foundation.

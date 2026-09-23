# Local Mail App composition and saved SQL queries

**Date:** 2026-09-08
**Status:** In Progress

Local Mail saves named SQL in its opened App and runs it against one Gmail
account's local cache.

Local Mail now opens one account App with data, SQLite, and secrets, plus an
exported `mail` object whose methods read that App when invoked. Completion is a verified
create, save, reopen, edit, select-account, run, and inspect workflow on browser
and desktop, starting fresh in the account-owned namespace.

## Decisions and execution boundaries

The durable proposals are [App resource ownership](../docs/adr/0376-application-authors-declare-data-and-the-opened-app-owns-resources.md),
[optional content codecs](../docs/adr/0377-a-table-may-omit-its-content-codec-while-every-row-owns-a-node.md),
and [saved-query semantics](../docs/adr/0378-local-mail-saves-sql-definitions-and-queries-cached-gmail-facts.md).
They distinguish the target from current exports. ADR status is not evidence
that implementation or verification exists.

The user chose module-private operation state and `export const mail`, with a
static import of the App binding and capability access inside operations.
Do not reintroduce `createMail({ app })`, a
product `ready` promise, or a second Device merely to recover its secrets.
Module-private admission and draining remain necessary for multi-step mail work.

The user authorized a clean break after the first execution checkpoint. Old
local caches, account registries, credentials, and pending work need not carry
forward. Do not build adoption, dual reads, migration journals, or a legacy
signed-out mode. Open fresh account-scoped storage and reconnect Gmail. This
removes backward compatibility; new saves, account isolation, and bounded
read-only execution remain required. No physical cleanup of old user files is
needed to implement the new composition.

## Composition direction and remaining order

[ADR-0376](../docs/adr/0376-application-authors-declare-data-and-the-opened-app-owns-resources.md)
is the composition overview. The related proposals distinguish the actor, the
selected library, resource shutdown, optional codecs, and restricted SQL.
The current API still uses `openAccount`; `openPersonal` and `openShared` belong
to the separate library-ownership implementation. Do not publish aliases here
or claim that renaming an opener implements Shared authorization.

Remaining execution order:

1. Finish browser interaction evidence against the production App and OPFS
   worker, including dirty/remote conflicts, blocked persistence, account
   switching, and departure.
2. Verify the actual mounted route and consent callback without opening another
   primary library. Keep this separate from isolated panel evidence.
3. Re-run final checks once concurrent App shutdown work settles. Do not edit
   its resource boundaries to accommodate an intermediate checkout state.
4. Exercise the desktop workflow, real keychain reopening, and live Gmail when
   those runtimes and credentials are available. Record unavailable checks
   explicitly; typechecks and synthetic fixtures do not establish them.
5. Retire the spec/handoff only when their verification obligations are spent.

## Read evidence before implementation

These are inspected entrypoints, with some files read in excerpts. Recheck
current code because this checkout is shared and changing.

```text
apps/
|-- local-mail/
|   |-- README.md
|   |-- package.json
|   |-- src/
|   |   |-- accounts.ts
|   |   |-- handle.ts
|   |   |-- mailbox.ts
|   |   `-- storage.ts
|   `-- ui/
|       |-- package.json
|       `-- src/
|           |-- lib/
|           |   |-- create-mail.ts
|           |   |-- mail.ts
|           |   `-- platform/ (device and Gmail authorization leaves)
|           `-- routes/ (+page.svelte and +layout.svelte)
|-- honeycrisp/src/lib/ (runtime.ts, application.ts, data.ts)
|-- whispering/src/lib/ (runtime.ts and platform resource leaves)
`-- epicenter/src/ (device.ts, app-secrets.ts, server.ts)
packages/
|-- app/ (README.md, package.json, src/index.ts, src/browser.ts)
|-- data/
|   |-- README.md
|   `-- src/
|       |-- definition/ (index.ts, define.ts, declaration.ts, compile.ts, content.ts)
|       |-- store/ (browser.ts, store.ts, document.ts)
|       `-- artifact/ (render.ts, import.ts, checkout.ts)
|-- device/src/ (index.ts, owner.ts, protocol.ts, browser.ts, desktop.ts,
|               browser-sqlite.worker.ts)
`-- sqlite/src/browser.ts
```

Read the nearest existing tests when implementing each checkpoint. Earlier
reviews inspected artifact test excerpts, but did not run those tests.
The vault note `~/Code/vault/pages/2026-09-02-compose-in-vanilla-then-add-reactivity-last.md`
explains deferred operation access versus eager module evaluation.

Related in-flight work must be coordinated, not overwritten:

- [ADR-0373](../docs/adr/0373-product-operations-receive-the-page-owned-app-explicitly.md)
  already proposes call-time product access. Reuse its import-safe bootstrap
  pattern; do not create another ADR for the same decision.
- [ADR-0375](../docs/adr/0375-local-and-personal-data-preserve-named-account-ownership.md)
  and its [API handoff](20260909T062714-library-ownership-api.handoff.md) reconsider
  actor versus library destination. This feature initially targets Personal.
  It does not implement Shared libraries or assume Shared credentials.
- [ADR-0318](../docs/adr/0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md)
  and [ADR-0319](../docs/adr/0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md)
  explain artifact ownership and the Google-subject partition.
- [ADR-0368](../docs/adr/0368-local-mail-preserves-known-cache-schemas-during-upgrades.md)
  and [ADR-0370](../docs/adr/0370-local-mail-downloads-the-mailbox-and-maintains-it-through-history.md)
  provide cache preservation and download context. Verify status and code.

## Current implementation

`defineApplication` selects package-owned resources. Local Mail declares
`mailDefinition` in `ui/src/lib/data.ts` and opens the captured Account through
`openAccount` in the mounted application module. The separate library-ownership
work owns the Personal/Shared opener change. Do not add aliases here.

`application.ts` imports `mail.ts` to compose departure; `mail.ts` statically
imports the App binding but reads it only inside admitted operations. This ESM
cycle performs no capability access during evaluation. An extra document
controller solely to break the import cycle would duplicate existing ownership.

`mail` owns its pending workflow set and AccountWorkflow state. Core account
functions take that state and scoped capabilities, without creating a Device or
another lifetime. SQLite and secrets come from App. Local reads avoid Gmail
client construction; query execution calls the cache database directly with
fixed `messages` and `labels` access.

`savedQueries` contains ordinary `name` and `sql` fields and no codec. The panel
supports create, save, reopen, edit, delete, malformed-row repair, conflict
choices, explicit Run, and transient positional results. Its preflight flows
through the shell to document departure before UI producers are stopped.

The browser OPFS and native Rust executors enforce restricted queries. Production
engine, transport, and owner verification passed during the independent SQL
checkpoint. Browser interaction evidence is a separate harness under Local
Mail. Full desktop computer-use and live Gmail/keychain reopening remain
separate obligations; engine tests do not stand in for them.

## Ownership and workflow

```text
package-owned platform construction
  -> application definition
    -> mounted bootstrap opens one Personal App
       |-- savedQueries rows: authored data, synchronized
       |-- SQLite: local cache and durable intentions, separate files
       `-- secrets: local token backing, separately scoped

UI after successful readiness
  -> save / rename / delete through app.tables.savedQueries
  -> mail.query(captured Google subject, captured SQL)
    -> document and account admission
    -> selected mail cache only
    -> restricted adapter operation
    -> transient ordered columns and positional rows
```

Use ordinary string fields and the store's row ID. SQL is whole-field data with
existing conflict semantics. Do not duplicate it in content or add timestamps,
saved account binding, enabled flags, result modes, or parameter schemas.
The empty content node needs no editor or undo manager.

Save and Run are separate. Invalid SQL may be saved for repair. Show actual
persistence status; an in-memory write is not a durable save. Show nonconforming
rows with a repair/delete path. An editor draft is legitimate uncommitted state,
but a synchronized update must not silently overwrite a dirty draft. Choose a
small explicit save/reload conflict interaction; do not build a merge editor.

Results read cached Gmail facts and can cover only the download completed so
far. Show the selected account, existing cache status, and "Pending changes are
not included." Keep results separate from triage and render values as text.
Explicit Run captures SQL and account; reject late publication after selection
or run changes. Errors do not mutate the saved query or the mailbox.

## Work backward from the completed workflow

| Observable outcome | Prerequisite |
| --- | --- |
| Create, save, reopen, edit, run, inspect on both builds | UI over a ready App and proven executor |
| Reopen newly created mail and intentions | Durable account-scoped storage and offline identity behavior |
| Execute without writes or cross-account access | Engine-enforced bounded SQL operation |
| Use one App without constructor plumbing | Standard platform composition and scoped secrets |
| Declare only name and SQL | Optional codec authoring and artifact verification |

Execute in these checkpoints. Rebase the plan on evidence after each review.

### 0. Establish the live boundary and start with account-owned storage

- [x] Capture scoped status/diffs and fresh verification baseline. No resetting,
  stashing, or staging unrelated work. Shared App/auth changes are already live.
- [x] Coordinate with the ownership/API work. Use its actual Personal opener
  and import-safe publication if they land; do not independently redesign Shared.
- [x] Open only the fresh account-owned namespace. Remove historical durable
  and cache-schema upgrade branches when replacing Local Mail's storage opener.
  Do not read or adopt the previous local scope or its credential labels.
- [x] Require identity for first opening. Cached identity plus the new App must
  reopen offline; no network health gate may disable new triage/Undo/outbox.

The ownership/adoption product blocker is resolved by the clean break. Browser
offline reopening is covered by the production-panel harness; desktop evidence
remains separate.

### 1. Prove restricted SQL before building the editor

- [x] Inspect installed browser WASM and native APIs. Select a supported
  enforcement mechanism for each: browser SQLite WASM and Rust-owned desktop
  SQLite now implement the restricted operation.
- [x] Prototype Rust as the sole desktop SQLite backend behind the shared
  lifetime owner before committing to Bun writers plus Rust readers. Compare
  trusted run/all/batch, restricted reads, open/close/delete, error transport,
  and draining. One backend may still use separate trusted/read connections.
- [x] Prove one statement using SQLite parsing/tail handling, not string
  splitting or SELECT-prefix checks. Bind runtime values separately.
- [x] Deny writes, schema changes, attachments, transaction control, PRAGMAs,
  unsafe functions, extension loading, and access beyond the allowed mail
  relations. Allow SELECTs, CTEs, joins, aggregates, and JSON inspection.
- [x] Set concrete row, byte, and execution-work/time limits with evidence.
  Preserve headers on zero rows and duplicate column names with positional rows.
  Choose consistent integer/BLOB transport and rendering across adapters.
- [x] Test cancellation/timeout and cleanup on actual engines. A rejected query
  must leave trusted synchronization writes usable. Do not toggle restrictions
  across separate asynchronous requests on a shared connection.
- [x] Independent design review of the proven operation and its integration
  cost. If one runtime cannot enforce the promise, report the mechanism gap;
  do not substitute a weaker fallback or call the feature complete.

### 2. Land the small Data declaration change

- [x] Make content optional with no implicit codec. Keep node provisioning,
  reserved keys, exact inference, and supplied-codec validation.
- [x] Test empty round trips, populated sequence/attribute refusal, incoming
  nonempty body refusal, and checkout field edits. Correct generated artifact
  guidance and stale comments. Do not remove existing codecs without an audit.

### 3. Make App the resource owner

- [x] Move standard resource selection into package-owned build-condition
  leaves. Preserve real per-app destination and settings differences. No
  mutable global registration or replacement runtime wrapper in every app.
- [x] Add scoped secrets through browser backing, desktop protocol, host/native
  addressing, and App lifetime guards. Do not persist browser tokens or sync them.
- [ ] Verify matching IDs under different accounts/servers, reopened keychain
  access, same-document memory scope, closure rejection, and safe operation drain.
- [x] Review the cumulative ownership change independently before Local Mail
  adopts it. Keep factory injection only where an actual runtime boundary earns it.

### 4. Compose mail and implement the complete workflow

- [x] Introduce Local Mail's definition and mounted App bootstrap/publication.
  Use checkpoint 0's fresh account-owned namespace when switching storage owners.
- [x] Replace public `createMail` setup with `export const mail` and
  module-private admission, storage-open state, and per-account activity.
  Import Gmail authorization directly. Access App only during admitted calls.
- [x] Retain durable-only triage/Undo and cache-optional outbox reads. Query
  execution must not construct a credential-bearing Gmail session.
- [x] Add one saved-query panel for list/create/edit/save/delete/run and results.
  Storage failures remain visible; results remain transient and account-specific.
- [x] Stop producers, drain admitted mail work, then close App on departure.
  Verify normal routes, callbacks, preloading, and teardown after failed opening.

### 5. Prove, remove old composition, and finish

- [ ] Run automated checks and computer-use evidence below. Review cumulative
  implementation, including helpers mentally inlined into their callers.
- [x] Once replacement behavior is proven, delete unused Device/factory wiring,
  duplicate closure paths, placeholder codecs, and stale docs within task scope.
- [ ] Update Local Mail and package READMEs and durable records to describe
  actual behavior. Follow ADR status authorization rules; shipping is not approval
  to mark an ADR Accepted. Delete this spec/handoff when their work is spent and
  record history using the repository convention.

## Verification matrix

| Boundary | Required evidence |
| --- | --- |
| Saved data | Create/update/delete, flush and reopen, offline reopen, sync between replicas, blocked persistence, nonconforming row handling, dirty-draft conflict |
| SQL isolation | Same message ID in two Gmail caches; no other-account, durable-intent, or secret access; no mutation of rows/schema/cursors |
| SQL failure | Syntax errors, missing relations, multiple statements, DML RETURNING, ATTACH, PRAGMAs, unsafe functions, bounded recursive/aggregate work, recovery afterward |
| Results | Zero rows retain columns, duplicate aliases survive, NULL/integer/BLOB values, row/byte truncation is reported, cells render as text |
| Pending intentions | Pending archive/Undo changes triage immediately while SQL follows cached facts until cache update |
| Lifetime | Removal drains runs, stale result suppression, close during opening/execution, callback/preload acquires no primary library |
| Fresh ownership | Old local scope is never adopted; new data survives reopen; identity changes and credential deletion remain isolated |
| Browser | Reload retains mail and saved queries but loses Gmail tokens; local queries still run |

Commands verified from current package scripts (recheck before execution):

```sh
bun test --cwd apps/local-mail
bun run --cwd apps/local-mail typecheck
bun run --cwd apps/local-mail/ui typecheck
bun run --cwd packages/app typecheck
```

The UI script checks browser and epicenter-host conditions. Also run focused
Data, Device, native-host, and application tests plus typechecks for every
changed consumer. Tests against Bun memory fixtures do not prove browser or
desktop transport enforcement. Use real adapters for the SQL contract suite.

Computer-use evidence: create a query, save it, reload, reopen, edit, switch
Gmail account, Run, inspect results, run invalid and write SQL, and repeat
offline. Test both builds where control is available. Use synthetic mail for
repeatable captures; do not publish real mailbox contents. Record unavailable
computer-control tools or desktop runtime as unverified, not a pass.

Live Gmail evidence remains distinct: successful initial download/history
maintenance and pending-label delivery with a working connection. The user
reported a previous 165-test pass and core/both UI typecheck passes; those are
historical context. This design session ran no feature regression suite and
did not verify live Gmail. A later report must separate automated fixtures,
real-adapter probes, computer-use checks, and live-provider checks.

## Example SQL

```sql
SELECT id, subject, sender,
       datetime(internal_date / 1000, 'unixepoch') AS received
FROM messages
ORDER BY internal_date DESC, id
LIMIT 100;
```

```sql
SELECT sender, count(*) AS messages
FROM messages
GROUP BY sender
ORDER BY messages DESC
LIMIT 25;
```

```sql
SELECT m.id, m.subject, m.sender
FROM messages AS m
WHERE EXISTS (
  SELECT 1 FROM json_each(m.label_ids) AS label
  WHERE label.value = 'UNREAD'
)
ORDER BY m.internal_date DESC
LIMIT 100;
```

## Completion and remaining judgments

The implementation is complete when the full workflow and new-data integrity
invariants are proven, the required automated checks pass, and the independent
review findings are resolved. Required but unavailable live/computer-use checks
must be named explicitly; do not claim end-to-end verification from typechecks.

Still to verify: complete desktop workflow, real keychain reopening, live Gmail
download/history/delivery, and final compatibility with concurrent App resource
and library-ownership work. These are specific launch questions,
not invitations to rebuild auth, invent a SQL language, or add a generic query
framework. No cross-account joins, effective-mailbox SQL, persistent results,
automatic execution, parameter UI, range tracker, or anonymous fallback library
is part of the selected first slice.

## Execution checkpoint: 2026-09-08

Checkpoint 2 is implemented and independently reviewed. `defineTable` permits
omission without a default codec; supplied malformed codecs still fail. Public
declaration tests cover exact inference, empty artifact round trips, populated
sequence/attribute refusal, incoming-body refusal, and checkout field edits that
preserve the node. Existing table codecs and storage composition are unchanged.
Review repairs corrected stale comments and the SQL evidence harness's error
reply and cleanup paths.

Checkpoint 0 remains unimplemented, but its product blocker was subsequently
resolved: the user chose a clean break with fresh account-owned storage. The
actual App API still exposes `openAccount`; the Personal/Shared handoff is a
design pass, not a landed replacement API. Existing Local Mail SQLite uses the
local namespace, and secret labels carry only app ID and Google subject. No
migration or App/bootstrap replacement has run. Adoption is no longer planned.

Checkpoint 1 remains open. The reproducible gap probe is
`packages/device/evidence/sql-query-boundary.ts`. It exercises real Chromium and
WebKit OPFS workers and the desktop WebSocket client/dispatcher over a temporary
Bun-backed file. Hosting/auth and Bun's page lock are fixtures. All three permit
DELETE RETURNING, ATTACH, PRAGMA, and transaction control through `all()`, lose
duplicate aliases, and return no headers for zero rows. Invalid SQL is reported
and trusted writes still work afterward. These are observations of the existing
trusted API, not a restricted executor or full desktop application test.

The independent native review found no supported authorizer/progress API in
installed Bun 1.3.1. Its internal handle is not a C pointer; `node:sqlite` is not
available. The next candidate is a separate Rust-owned bundled SQLite connection
over the existing native pipe. This is an implementation choice to prove, not a
reason to weaken isolation. Browser WASM exposes the needed callbacks, but its
prepare wrapper requires a WASM SQL pointer to retain the parser tail. Neither
production adapter exposes a restricted operation yet. Build that operation and
verify its limits before implementing the editor.

Fresh verification:

| Check | Result |
| --- | --- |
| Local Mail suite | 165 tests pass, 609 assertions |
| Local Mail core typecheck | Pass |
| App typecheck | Pass |
| Full Data suite | 582 tests pass, 2,117 assertions |
| Data typecheck | Pass |
| Device typecheck, including existing OPFS evidence page | Pass |
| New SQL gap evidence script, standalone strict typecheck | Pass |
| Local Mail browser UI typecheck | 14 baseline errors in shared `server-connection.svelte` and `sign-in-screen.svelte` |
| Local Mail host UI typecheck, invoked separately | Same 14 baseline errors |
| Real adapter gap probe, Chromium and WebKit | Completed; confirms unrestricted API above |

An isolated browser policy prototype in
`/tmp/local-mail-execution/browser-probe` passes mechanism assertions in both
engines: permitted SELECT/CTE/JSON inspection, denied writes/attachments/PRAGMA
and other tables, parser-tail rejection, VM interruption, row truncation, empty
headers, duplicate aliases, and trusted-write recovery. It runs directly on an
OPFS WASM connection, outside the production dispatcher. Its small function
allowlist and partial value transport do not establish the complete contract.
The current prototype uses a 64 KiB SQL limit, 1 MiB SQLite value limit, 128
columns, about 100,000 VM operations, 100 rows, and 64 KiB collected row JSON;
these are probe parameters, not settled production limits. In particular,
`count(*)` emits an empty-column READ with no database name, so a policy must
not allow every such READ merely to accommodate CTEs.

The isolated native prototype in `/tmp/local-mail-execution/native-probe` uses
`rusqlite` 0.40.2 with bundled SQLite 3.53.2. It passes 42 cases per journal mode
against files written by Bun 1.3.1 on macOS arm64, including rollback journal and
WAL. It exercises allowed queries, denied operations/relations, parser tails,
work interruption, result limits, and positional values. Original rows, schema,
and sync cursor survive; Bun writes successfully afterward and that write
survives reopening. This is a separate Rust executable, not the host/native pipe
or desktop application. Production transport, lifetime integration, consistent
browser/native value encoding and limits, and other operating systems remain
unverified. Reproduce with:

```sh
cargo build --manifest-path /tmp/local-mail-execution/native-probe/Cargo.toml
bun /tmp/local-mail-execution/native-probe/run.ts
bun /tmp/local-mail-execution/browser-probe/run.ts
bun /tmp/local-mail-execution/browser-probe/run.ts --webkit
bun packages/device/evidence/sql-query-boundary.ts
bun packages/device/evidence/sql-query-boundary.ts --webkit
```

Use the proven mechanisms for the next implementation wave: WASM authorizer,
pointer-based preparation, and progress callback in the browser worker; an
independently owned bundled SQLite read connection in Rust on desktop. Keep all
enforcement installed until finalization. The prototypes do not settle the
production allowlist, bounds, cancellation transport, or query result contract.

The UI errors were captured before feature edits. They concern removed auth
members such as `isBrowserAuth`, `method`, and `signInLocation`; no task code
changes those components. Current status and tracked baseline diff are retained
in `/tmp/local-mail-execution/baseline-status.txt` and `baseline.diff`. Verification
logs are in that directory. Existing App/auth/inference/store edits were not
reset, staged, or treated as task-owned. No commits or real-data deletion ran.

Computer-use of the requested workflow and live Gmail checks remain unperformed:
the workflow is not built. Browser engine probes do not count as those checks.
Keep this spec and handoff until the remaining checkpoints are complete.
The documentation hygiene command reports 36 ADR bookkeeping flags; it does not
pass. No terminal-status spec was introduced, and no ADR status was changed.

## Clean-break design checkpoint

The independent review supports deleting the Device/MailApp/createMail
composition chain in favor of one opened App and module-private mail operation
state. Cache reads should acquire only cache capabilities; `withSession` should
not construct Gmail credentials for local reads. Keep per-Gmail-account
admission/removal state: removing one Gmail account while the App remains open
is a different lifetime from closing the entire document.

The clean break avoids unwritten adoption machinery and permits deleting old
schema-upgrade branches. It does not remove durable intentions, cached-fact
versus pending-intent semantics, secret isolation, or the restricted SQL engine
boundary. Optional codecs already provide the small fields-only declaration
needed here; a second row representation would add complexity.

Native ownership is reopened for a bounded prototype. Moving all desktop SQLite
execution to Rust could delete the Bun physical adapter and mixed-engine
compatibility work. It would require native transport for every trusted
operation, so the restricted-read prototype alone does not settle that choice.
Resolve it before freezing the production executor. No production implementation
or additional test pass occurred during this design checkpoint.


## Resource design checkpoint: 2026-09-09

The independent review reconstructed the package resource selection, document
lifetime, secret backings, and AI response-body lifetime. Standard applications
now import `defineApplication` from App. Browser and host builds select SQLite
and secret implementations once; Honeycrisp and Vocab no longer repeat runtime
or SQLite platform wrappers. Whispering retains its actual recording, blob, and
transport differences.

The review found duplicate operation tracking in the new App secrets wrapper.
That wrapper and its close aggregator were deleted. The document constructs
secret methods beside SQL methods and admits/drains both through its existing
operation set. Retained methods throw after close; ordinary backing Results pass
through unchanged. The public `AppResources` annotation was removed. Host shape
checking derives from the browser leaf without importing the App entrypoint.
AI body tracking stays separate because resolving response headers does not end
a stream.

Verification after the collapse: App suite 63 passed, both App platform
typechecks passed, and all Data typecheck tiers passed. Tests cover reentrant
close, delayed secret writes, identical Err forwarding, scope separation, and
same-document reopening. Native keyring address tests passed; actual keychain
reopening has not been exercised. Shared boot UI now consumes the current
AuthStartup contract. Local Mail and Honeycrisp both UI conditions and Vocab
check with zero errors. Chromium AppBoot smoke passed; WebKit failed at initial
navigation with TargetClosedError and is not a pass.

The next working wave is the restricted query operation on actual browser and
native engines. SQLite cancellation uses a separate transport message that
bypasses the statement queue; completion still waits for engine cleanup. The
first shared-owner tests pass for active cancellation, cancellation while
queued, and cleanup before physical close. Query UI and Local Mail adoption
remain pending until the engine boundary is reviewed.


## SQL and composition documentation checkpoint: 2026-09-09

ADR-0376 now distinguishes current construction from the Personal/Shared and
resource-shutdown targets. ADR-0378 fixes the Local Mail policy in product code;
new ADR-0381 records the reusable SQLite execution boundary. Historical
migration promises and the unresolved-native-feasibility description were
removed from ADR-0378.

The independent SQL review retained the scoped owner design and found concrete
transport and policy defects. Repairs cover binary values through the actual
desktop WebSocket, local native request refusal without poisoning the port,
terminal pipe completion, browser physical JSON-table shadows, nonfinite native
results, whole-result byte limits, trusted SELECT compatibility, and native
cancellation checks during row materialization.

Chromium and WebKit production harnesses pass after those browser repairs.
Native verification reports 74 focused Bun tests, four Rust tests, and the live
TypeScript-to-Rust integration passing. The actual server-socket binary test
also passes. Full App/Device and Data checks passed earlier in this wave;
full host-suite verification additionally exposed two account-selection test
timeouts whose baseline attribution remains unresolved. Local Mail's 165
existing tests pass, but its saved-query workflow is still unbuilt.


## Local Mail integration checkpoint: 2026-09-09

Local Mail now uses one mounted Account App and module-owned mail workflows.
Public createMail/createMailApp/MailApp and the app-specific Device leaves are
removed. Stateless core AccountWorkflow functions retain the removal and
reconciliation invariants. Local cache reads construct no Gmail client.
Fresh account-owned schemas start at version 1; old physical user files remain
untouched, and new caches and durable intentions reopen in place.

Saved queries have a codec-free declaration and a persistent editor with
explicit remote conflicts, malformed-row repair/delete, draft navigation and
departure preflight, and captured-account Run. SQL results preserve positional
headers, show exact integers/hex blobs as text, and exclude pending triage.
Gmail browser consent uses a separate window whose callback opens no library.
The primary window retains its verifier, App, and credentials.

Independent SQL and cumulative implementation reviews retained the owner
boundaries. Repairs included newline-inclusive native frame admission, local
API CORS/callback permission, combined API/UI development startup, and the
hexadecimal result label. No unresolved production correctness finding remains
from those reviews. The plan no longer forbids the deferred-access import cycle
that lets application.ts coordinate mail and App departure.

Verification after the concurrent App shutdown changes settled:

| Check | Result |
| --- | --- |
| Local Mail tests | 160 pass, 0 fail |
| App, Device, and Data tests together | 763 pass, 0 fail |
| Local Mail core and both UI typechecks | Pass |
| App and Device typechecks | Pass |
| Host Home typecheck | Pass |
| Browser and host Local Mail builds | Pass |
| Production panel/App/OPFS workflow, Chromium and WebKit | 12 checkpoints pass in each engine |
| Actual built primary route, Chromium and WebKit | 8 checkpoints pass in each engine |
| Gmail consent callback protocol, Chromium and WebKit | Pass with synthetic consent; ordinary popup permission unproven |
| Data package typecheck | Fails on DOM types in concurrent library-ownership browser/evidence files |
| Documentation hygiene | 40 status/dependency findings; no ADR status changed |

The panel checks include invalid SQL save, offline reload, account isolation,
write refusal/recovery, exact and text-only results, dirty navigation and
preflight, actual peer edits, malformed repair/delete, actual IndexedDB quota
failure/retry, and worker cancellation. The actual-route checks cover callbacks,
SvelteKit hover preload, signed-out boot, ready-gated authenticated shell,
preflight cancellation, and durable close/reopen. All use synthetic identity or
provider responses; no real mailbox contents appear in captures.

Reproduction commands and fixture boundaries are in
`apps/local-mail/evidence/README.md`. Local diagnostic logs and screenshots are
under `/tmp/local-mail-continuation/`; they are aids, not portable evidence.

Complete desktop WebView computer-use, real keychain reopening, live Gmail
initial/history/delivery, and ordinary browser popup-policy verification remain
unperformed. The desktop build and native engine checks do not prove those
interactions. Keep the spec/handoff for these verification obligations. Shared
Data type errors remain with the concurrent library-ownership work; no package
resource owner was overwritten to resolve an intermediate checkout failure.

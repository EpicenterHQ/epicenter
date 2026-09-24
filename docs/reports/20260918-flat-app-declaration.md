# ADR-0405: flat application declarations

`defineApp({ id, title, kv, tables })` replaces `defineApplication` with one
inert, inspectable declaration. Honeycrisp, Vocab, Whispering, and Local Mail
use that same object for schema consumers and opening. Lower-level
`defineData` remains available.

The starting commit was `f730a87ddd268f63150320fa69fe842d7ec6ebcd`.
Existing dirty work was inventoried before editing. Its tracked diff,
including the partial ADR-0365 change, was compared byte-for-byte after the
implementation and remains unchanged. Nothing was staged.

## Invariants and scope

The declaration exposes the schema and `.open()`; implementation bindings
remain in its closure. Runtime validation uses the existing `compileData`
owner. The declaration preserves table and KV inference, authoring refusals,
and Account, undefined, and union opening overloads. Opening remains the
point that captures an Account and acquires resources. Readiness and close
ownership remain in the existing App implementation.

Canonical JSON for all four production declarations was compared against their
source at the starting commit. Every byte matched, including IDs, table and
field names, titles, and schema metadata. Function-valued `.open` is omitted
by the existing canonical serializer. No stored data, credential, setting,
account namespace, or provider connection was migrated, adopted, or deleted.
No runtime-selection or SQLite implementation changed.

Local Mail's synthetic browser peers now share the fixture application's
schema identity and use separate synthetic principals for local isolation.
These are acceptance fixtures with disposable browser profiles. Production
Local Mail retains `so.epicenter.local-mail` and its existing account ownership.
The peer-edit and malformed-row acceptance assertions remain intact.

## Independent review

An independent GPT-6 reviewer reconstructed the existing design before edits
and reviewed the cumulative implementation. It accepted the declaration/live
App boundary and the retained ownership of validation, readiness, and closure.
It found two issues during the implementation checkpoint: omitted-title
inference and an outdated application-authoring guide. Both were repaired and
checked again.

The reviewed surface was:

```text
apps/
|-- README.md
|-- honeycrisp/src/lib/{data,application,boot-node.test}.ts
|-- vocab/src/lib/{data,application,application-failure.test}.ts
|-- whispering/src/lib/
|   |-- {data,bootstrap,bootstrap-failure.test}.ts
|   `-- whispering/app.test.ts
`-- local-mail/ui/
    |-- src/lib/{data,application}.ts
    `-- evidence/browser/{application,main}.ts
packages/
|-- app/
|   |-- README.md
|   |-- src/index{,.test,.test-d}.ts
|   |-- src/{app,scopes,recording,blob-retirement}.test.ts
|   `-- scripts/{browser-smoke.ts,shared-ai-catalog-native/page.ts}
|-- constants/src/apps.ts
`-- device/src/browser.ts
scripts/signed-out-workspace.test.ts
docs/adr/0405-one-flat-application-declaration-opens-the-live-app.md
```

The review also traced unchanged opening, resource factories, schema
compilation, in-memory stores, and account ownership. No lifecycle or storage
correctness blocker remained. No live `defineApplication` reference or
compatibility alias remains in applications, packages, or scripts. Historical
ADRs and in-flight specs retain their original proposals.

## Verification

251 focused tests passed in disjoint suites:

| Suite | Passed |
| --- | ---: |
| App and device | 215 |
| Signed-out workspace reopening | 8 |
| Honeycrisp artifact round trips and boot ownership | 8 |
| Vocab synchronous opening-failure cleanup | 2 |
| Whispering synchronous opening-failure cleanup | 2 |
| Whispering App, Markdown export, and local-model schema | 7 |
| Lower-level data declarations | 9 |

Typechecks passed for App browser/host, app-shell, Honeycrisp browser/host,
Vocab, Whispering browser/host, and Local Mail UI browser/host/evidence.
Compile-time tests cover field and identity literals, omitted title, invalid
KV declarations, table branding, explicit store destinations, and all Account
opening overloads.

All six Local Mail browser journeys passed in Chromium and WebKit: saved
queries and remote changes, offline storage and recovery, primary-route
startup and durable reopen, and Gmail callback validation/cancellation.
The schema modules also imported under default and host conditions without
acquiring storage or network resources. Native acceptance from the preceding
wave was not rerun; its runtime and storage implementations did not change.
Task-owned TypeScript files pass formatting, and the task diff passes whitespace
checks.

## Remaining failures

The two Vocab/Whispering boot tests still expect old Session component names.
The isolated Whispering import test still cannot resolve
`$lib/constants/import-formats`. This wave reran those tests and observed the
same failures described with baseline comparisons in the
[preceding SDK report](20260918-single-sdk-clean-break.md#failures-and-limits).
Neither failure was repaired or counted in the passing suites.

The host's documented `account-transport.test.ts:242` optional-owner type
failure is outside this change; the host typecheck was not rerun. The preceding
report contains its baseline reproduction. App host-target checks passed here.

A broader Biome check of touched files reports four errors on unchanged
expressions: constant conditions in `index.test.ts` and `scopes.test.ts`, and
assignments in expressions in `recording.test.ts` and `device/src/browser.ts`.
It also reports existing non-null assertion warnings. These are not a clean
repository-wide lint result. No repository-wide green test or typecheck claim
is made.

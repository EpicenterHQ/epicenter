# Store-owned SQLite implementation

Local and Personal stores now own a SQLite namespace. `store.sqlite.open(name)`
and `store.sqlite.delete(name)` return Results. The namespace has no public close;
store close fences SQL before document abort callbacks and drains physical cleanup.
The public `@epicenter/app/sqlite` export and standalone constructor are removed.

Personal captures Account before admission, but passes only authority and principal
to SQL. Account transport functions never cross the worker or native SQL boundary.
SQL remains local and does not synchronize through the document. Test runtimes
supply private WASM SQLite owners alongside isolated IndexedDB and blob bindings.
The physical owner and its statement ordering, fencing, and exclusion are unchanged.
Thrown SQL acquisition failure conservatively retains the store claim because the
binding has not proved rollback; acquired document/blob resources still close.

## Caller and storage audit

| Former caller | Current ownership |
| --- | --- |
| Local Mail resource opener and browser evidence | Borrow `personal.sqlite`; Personal closes SQL |
| Epicenter runtime-lifetime evidence | Borrow its existing Local store's SQL |
| Shared AI catalog native acceptance page | Direct desktop physical owner; this tests host teardown, not a SQL-only product API |
| Device memory, owner, desktop tests and browser/query probes | Direct low-level physical owner |
| Local Mail native storage probe | Direct desktop owner with explicit synthetic Alice/Bob identities |

No production SQL-only consumer was found, and no empty store was introduced for
probes. Local Mail's `app.sqlite` composition field is a borrowed reference to
`personal.sqlite`, not another constructor or owner. Secrets and inference remain
independent resources. Local Mail now closes partially acquired resources if
startup fails or is interrupted, and closes Personal on departure even if navigation
stalls. Its tests cover interruption after each acquisition.

Address encoding is unchanged: Local uses `no-account`; Personal uses
`accounts/<hex authority>/<hex principal>`. The browser OPFS owner pool and native
storage continue using the existing application/database naming. No migration
scans, file renames, copies, erasures, or SQL rewrites were added.

Local Mail's existing no-account `local` file can contain `accounts`,
`label_intents`, `intent_counters`, and `last_pass`. Pending intents are unique
undelivered work. Known mailbox files contain Gmail messages, derived search
fields, labels, and sync checkpoints. Neither that inventory nor an account scope
makes arbitrary SQL disposable.

The new Personal namespace starts separately. Previously connected mailboxes do
not appear automatically. Reconnecting Gmail can redownload mail but cannot recover
pending triage from the old file. There is no legacy import/recovery UI or tool.
Keep old site/native storage until an explicit ownership-confirmed recovery can
inventory and import those records. See the [Local Mail limitation](../../apps/local-mail/README.md#existing-local-mail-data).

Secrets retain their existing application-ID/Google-subject scope. Accounts that
connect the same Google subject can share a token slot; credential isolation is
separate remaining work.

## Verification

The task-start app typecheck and 38 focused store/device tests passed. The checkout
already contained substantial row/body and other work, including staged changes.
A task-start diff and command logs were retained under `/tmp/store-sqlite-baseline`.
No task files were staged, committed, pushed, or deployed.

Passing checks:

- `bun run --cwd packages/app typecheck`: all configured source and evidence leaves.
- `bun run --cwd packages/device typecheck`: source and browser evidence.
- Local Mail core typecheck and UI typechecks for browser, host, and evidence.
- 49 focused app tests: SQL ownership, account snapshot/isolation, retained methods,
  admission, late acquisition cleanup, failed cleanup, imports, and browser document
  storage. Browser document unit tests explicitly bind isolated SQL.
- Local Mail startup failure/interruption test from the app package directory.
- 45 device tests, 148 Local Mail core tests, and 27 Local Mail UI tests.
- Real Chromium and WebKit OPFS probes: durability, physical contention, duplicate
  ownership, deletion/reopen, and separate Local/Alice/Bob/authority namespaces.
- Real Chromium store admission probe: 50 immediate replacements, 50 reloads,
  isolated memory runtimes, duplicate refusal, persistence, and teardown release.
- Local Mail browser journey in Chromium and WebKit: saved queries, restricted SQL,
  offline reopen, incompatible-row repair, and quota-failure recovery (2 passed).
- Native Local Mail evidence: 100 messages reopen, mailbox/account isolation,
  checkpoint recovery, and legacy no-account pending intent preservation.

The first real Local Mail browser run caught a full Account object reaching
`postMessage`, which memory SQL does not serialize. The fix projects only identity
fields and adds an explicit structured-clone boundary assertion. Both browser journeys passed after the fix. The journey also contained two stale
`app.account.personal` assertions; these now use the existing `app.personal` handle.

Broader checks have separate failures:

- Running the app suite from its package directory produced 702 passing tests and
  one Whispering startup-fixture failure in `fromData` because the fixture lacks
  `tables`. The original unmodified startup test reproduces that failure against
  the same checkout. This migration leaves the Whispering path unchanged.
- Root `bun typecheck` reports Honeycrisp's notes route passing Personal blobs to
  a Local-only prop type. All other reported package checks passed. That mismatch
  is outside the SQL edits; it was not reproduced in a full task-start checkout,
  so its baseline attribution remains unverified.
- Running the startup bundle test from the repository root also encounters Bun
  resolution errors for `wellcrafted/error` and `wellcrafted/logger`; running from
  the app package resolves those imports. Local Mail's startup assertions pass there.

## Review and remaining work

Two independent read-only Codex reviewers examined the ownership milestone and
cumulative integration. They confirmed the Local Mail rollback repair and the identity-only SQL transport
boundary after the real-browser regression exposed it. The store
claim and physical SQL owner remain separate because they protect different
resources and exclusion domains. Lazy SQL would violate mandatory readiness;
serial acquisition would change startup latency without a demonstrated need.
The existing parallel acquisition and late-success cleanup remain.

The cumulative inspection covered:

```text
packages/
|-- app/
|   |-- src/{open-store,store-runtime,sqlite,testing,platform/documents}.ts
|   |-- src/{store-sqlite,store-blobs,open-store,runtime,product-startup}.test.ts
|   |-- src/{index.test-d,import-boundaries.test,platform-selection.test}.ts
|   |-- src/data/store/{store,browser,browser.test}.ts
|   |-- scripts/shared-ai-catalog-native/page.ts
|   `-- {package.json,README.md,ARCHITECTURE.md}
|-- device/src/{owner,memory,browser,desktop,app-claim}.ts and tests
|-- device/evidence/{sql-query-boundary,browser/opfs-sqlite/main}.ts
`-- principal/src/device-owner.ts
apps/
|-- local-mail/{src/storage.ts,evidence/native-storage.ts,README.md}
|-- local-mail/ui/{src/lib/resources.ts,evidence/browser/application.ts}
`-- epicenter/evidence/runtime-lifetime/main.ts
```

Review also identified an existing physical-delete failure risk: a backend unlink
failure can leave a name reopenable in the same physical lifetime after its old
connection is removed. The physical owner was not changed by this migration;
failed-delete recovery needs a separate decision and fault-injection test.

ADR-0437 remains proposed. No checkbox, downloaded-data erasure, classification of
unknown databases, cross-window cleanup coordinator, or interruption recovery was
implemented. The combined spec and handoff remain as explicitly scoped planning
context for that unbuilt work. Legacy Local Mail recovery and credential isolation
remain distinct from sign-out deletion.

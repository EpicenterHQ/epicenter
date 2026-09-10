# Finish native acceptance for the shared AI catalog

Status: In Progress

Continue from the implemented catalog API. Produce reproducible evidence for
the remaining native desktop path, repair failures, and update the durable
documentation. Do not rebuild the connection/selection split.

## Start here

The original checkout is
`/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Find the implementation commit with:

```sh
git log -1 --oneline -- specs/20260910-shared-ai-catalog-native-acceptance.handoff.md
git status --short --branch
```

Other authentication, native recording, data, and planning changes were left
uncommitted. Inspect them before editing. The implementation commit includes
the prerequisite connection/selection split and the shared catalog; mixed host
files contain only the catalog hunks in that commit.

Read `packages/app/README.md`,
`docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md`,
and `docs/adr/0363-an-inference-selection-identifies-the-connection-and-model.md`.
Use current code for signatures and the ADRs for the decisions.

## The accepted design

```text
Independent product SPA
|
+-- Application selections: { connectionId, model }
|     Product-local; never inferred from model discovery
|
`-- Opened App
    `-- ai
        +-- account.client   Captured Account, when supplied
        +-- runtime.client   Explicit runtime binding, when supplied
        `-- connections      Same public API in either environment
            |
            +-- Browser binding
            |   `-- Product key in this origin's localStorage
            |
            `-- Desktop binding: local snapshot + host requests + SSE
                |
                `-- One catalog owner per desktop profile
                    +-- ai/connections.json: metadata and stable IDs
                    +-- OS keychain: optional provider credentials
                    `-- Inference broker: captured ID + access version
                        `-- Chosen OpenAI-compatible endpoint

Desktop App A ----+
                 +---- same profile catalog, independent selections
Desktop App B ----+
```

Sharing spans apps on one desktop profile, not devices. Browser apps retain
their origin/product catalog. Account and runtime capabilities remain separate
from editable custom records. A Local App still has no account inference.

After `app.ready`, use `app.ai.connections` in full. Do not alias the namespace.
`get(id)` and `getAll()` read local snapshots. `subscribe(listener)` immediately
supplies the current snapshot and then updates; it returns an unsubscribe.
Await `add`, `update`, `remove`, and `reorder` before showing success or selecting
a new entry. `preview(...).models.list()` discovers without saving.

Desktop snapshots expose `hasApiKey` without the stored key. Omit `apiKey` to
retain it; send `''` to remove it. Explicit desktop key assignment retires old
access even when the value matches. Metadata edits preserve clients and do not
read the keychain. URL changes preserve the credential reference but retire old
access. Missing keys can be replaced or removed without changing the saved ID.

Saved legacy records import once per product into the host, preserving IDs and
keys. Durable import markers prevent deleted entries from reappearing on reload.
Conflicting IDs fail instead of redirecting a saved selection. Workflow choices
remain separate; there is no fallback to another server or discovered model.

## Implementation map

- `packages/app/src/ai-connections.ts`: browser records, write serialization.
- `packages/app/src/ai-connections.epicenter-host.ts`: subscribed desktop view,
  initial import, host transport, and closure.
- `packages/app/src/ai.ts` and `open.ts`: SDK clients, readiness, retirement,
  and request draining.
- `apps/epicenter/src/ai-catalog.ts`: serialized metadata persistence, keychain
  references, immutable access versions, and custom request forwarding.
- `apps/epicenter/src/ai-catalog-routes.ts`: catalog commands, SSE, preview,
  inference routes. `server.ts` applies session and Origin checks.
- `apps/epicenter/src/main.ts`: one catalog under `boot.dataDir`, using the
  existing Rust-backed secret owner, with shutdown ownership.
- `packages/app-shell/src/inference-selections.ts` and `migrate-ai-settings.ts`:
  application choices and legacy conversion.
- `packages/app-shell/src/inference-picker/`: actual reactive picker, pending
  and failed saves, hidden-key editing, and late-result suppression.

The default AI binding uses the `epicenter-host` build condition. Merely opening
a browser build inside a WebView does not select that binding. Vocab's existing
standalone build is not evidence that Vocab is installed as a desktop product.

## Evidence and its limits

The implementation run passed 73 App tests and 62 host catalog/route/server
tests. Shell and Whispering operation tests, affected typechecks, and Whispering
browser and host builds passed. Root typechecking reproduced the same eight
Data diagnostics captured before the work; documentation hygiene reported 44
issues. Recheck these against the checkout you receive.

Before committing, a separate copy of the staged tree passed 73 App tests,
61 host tests, and 28 selection/picker tests, plus App, app-shell, host TypeScript,
and both Whispering typechecks. The two-test-SPA browser harness also passed
there. The staged host suite excludes the unrelated authentication test from
the working tree, which accounts for its lower count. Staged-check logs are
also in `/tmp/shared-ai-catalog-20260910/`.

Independent review retained the ownership boundaries and prompted the missing
key repair. Regression tests cover metadata edits without key reads and a
post-rename directory-sync failure: the latter preserves old/new key references
rather than deleting credentials a reverted metadata file might still need.

Browser checks prove:

- Browser migration, exact SDK routing, and cross-document selection/deletion.
- Two generated test SPA documents through real host routes: session/Origin
  checks, initial and live SSE snapshots, idle heartbeat, credential isolation,
  client retirement, import/reload, independent choices, and catalog reopen.
- The actual Svelte picker: awaited saves, failure without selection changes,
  hidden-key retention/removal, cross-window updates, and ignored late completion.

The shared-catalog harness uses a process-memory secret owner and reopens the
catalog in the same process. It does not exercise Rust keychain persistence,
restart the host process, or launch two built product SPAs. The picker harness
simulates the hidden-key binding. These limits are the next acceptance work.
Implementation logs and its task-start baseline are under
`/tmp/shared-ai-catalog-20260910/`; temporary evidence may disappear, so use the
checked-in scripts to reproduce it.

## Execute next

1. Inspect the current native launch and build procedures. Establish an isolated
   development profile and a controllable compatible endpoint. Use fixture
   credentials; preserve real profiles and their stored data.
2. Exercise the actual desktop binding in built app documents. Add an endpoint
   in one, observe it in another, and keep their workflow choices independent.
   Use supported installed apps or a clearly identified test app; do not
   describe generated documents as the shipped products.
3. Exercise the existing Rust secret bridge and real OS keychain. Verify key
   omission from snapshots/files, replacement/removal, missing-key repair, and
   refusal of stale clients after edits. Restart the host process and prove
   catalog IDs, credentials, and selections survive without reimporting deletes.
4. Verify app/window closure, SSE reconnect after interruption, and host shutdown
   release subscriptions and requests. Repair failures at their owning boundary.
5. Record actual commands and artifacts, review the cumulative change, update
   the README/ADR, and delete this handoff when its acceptance is complete.

The separate native microphone and capture-reload work remains in
`specs/20260909T171130-ai-runtime-integration.handoff.md`. Portable
`app.ai.dictation`, unified source lookup, and the signed-out invitation remain
separate design/implementation work. This handoff does not authorize deployment
or redesign those features.

## Reproduction commands

Run from the repository root with Bun. Run the two Whispering builds sequentially
because they share generated output.

```sh
bun test packages/app/src/ai.test.ts packages/app/src/ai-connections.test.ts packages/app/src/ai-connections.epicenter-host.test.ts packages/app/src/native-ai.test.ts packages/app/src/index.test.ts packages/app/src/app.test.ts
bun test apps/epicenter/src/ai-catalog.test.ts apps/epicenter/src/ai-catalog-routes.test.ts apps/epicenter/src/server.test.ts
bun test packages/app-shell/src/inference-picker/connections.test.ts packages/app-shell/src/inference-selections.test.ts packages/app-shell/src/migrate-ai-settings.test.ts
bun packages/app/scripts/ai-connections.browser.mjs
bun packages/app/scripts/shared-ai-catalog.browser.mjs
bun packages/app-shell/scripts/inference-picker.browser.mjs
bun run typecheck
bun run --cwd apps/whispering build
bun run --cwd apps/whispering build:epicenter
```

Done means the native path has repeatable evidence for real keychain persistence,
host process restart, and cross-app behavior. If a required host or fixture is
unavailable, identify the exact missing prerequisite and preserve the runnable
acceptance procedure; do not substitute mocked success for native evidence.

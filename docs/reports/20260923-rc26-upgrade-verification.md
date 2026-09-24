# RC26 upgrade verification

Epicenter now pins `@y/y@14.0.0-rc.26` and uses `Y.Node` throughout active
code, tests, executable evidence, and current guidance. Honeycrisp uses
`@y/prosemirror@2.0.0-12`. The accepted row layout is unchanged: JSON metadata
on the row, one stable body node as its sole sequence child.

## Baseline and scope

The task began on `d51eddd6b27b5044ecfdfa4d847a4c15426555ca`, with the
uncommitted body-layout implementation and unrelated shared work present.
The actual tracked and untracked files, working diff, and staged diff were
saved under `/tmp/epicenter-rc26-baseline-20260923T114730/`. HEAD was not used
as the implementation baseline. The upgrade was committed in dependency order:
`993fcb24ac` upgrades dependencies and patches, then `4308a8295f` commits the
row/body API and RC26 implementation across its consumers. Concurrent shared
work outside that scope remains unstaged. Nothing was pushed or deployed.

The fresh baseline passed 559 targeted tests, App typechecking, 17 Svelte
adapter tests, 5 notes tests, and 35 CLI tests. Whole-repository typechecking
already failed in Local Mail and Honeycrisp, as detailed below.

## Dependencies and bindings

All nine direct consumer workspaces, root tooling, ProseMirror, and protocols
resolve the same RC26 module and `Node` constructor. Root overrides also keep
lib0 at `1.0.0-rc.32`. The lockfile contains no Yjs 13 package. The size
benchmark and executable article benchmarks now use RC26; old published
measurements remain historical. The port-cost standalone browser bundle was
rebuilt and exercised.

Both old patches were removed. The ProseMirror renderer fix is upstream, and
no active caller needs the old Yjs internal updates export. One new patch is
necessary: undoing the first edit in an untouched body made the binding write
its schema-default paragraph back into Yjs, interfering with redo. The new
patch restores the virtual empty-content gate only when the projected body is
childless and the displayed document is initial content. It retains an empty
stored snapshot and clears the incremental document reference. Merely opening
an empty editor still writes nothing.

The defect was reproduced before patching with the actual Svelte editor and
independently with a real EditorView. The patched browser regression covers
undo/redo, another edit after undo, and empty rewrites. Independent review also
probed repeated undo/redo, remote insertion while gated, remote deletion to
empty, and local typing afterward. A frozen force reinstall verified patch
application; subsequent browser and targeted tests passed against that install.

Headless conversion calls `ynodeToPmnode(node, noteSchema)` directly. It fills
an empty schema top node without mutating Yjs, so the old empty-body helper was
removed. `pmnodeToDelta` produces an insertion delta, not a replacement; the
codec deletes the existing sequence and applies that delta within the caller’s
transaction, preserving the body object.

Exact installed source and types were decisive, including
`@y/prosemirror/src/{convert,sync-utils,rdt/prosemirror}.js` and
`@y/y/dist/src/ynode.d.ts`. Upstream references:
[Yjs exports](https://github.com/yjs/yjs/blob/main/src/index.js),
[Yjs node](https://github.com/yjs/yjs/blob/main/src/ynode.js), and
[ProseMirror conversion](https://github.com/yjs/y-prosemirror/blob/master/src/convert.js).
The moving upstream branches are orientation; the installed exact versions
establish the behavior tested here.

## Storage and API guarantees

The store still creates the row and body together. Reads neither create nor
repair nodes and require exactly one correctly typed child. Metadata updates
cannot replace it. Deletion removes the subtree. Value snapshots, independent
`table.body(id)` access, fresh-body creation, artifact `{ id, fields, body }`,
and checkout’s distinction between metadata and body operation kinds remain.

New regressions cover body-owned attributes surviving in-place rewrites and
persistence/reopen, retained-reference edits after deletion, and a transaction
that changes both metadata and writing with one notification per signal.
Existing coverage verifies field names `body`, `content`, and `!status` beside
the collaborative body, conformance independence, artifact serialization,
checkout, and synchronization.

RC26 still restricts configured `insert` children to `Fingerprintable` and
does not translate that argument to live node children. The localized
`as never` at row-child insertion remains documented; metadata was not widened
to hide that upstream declaration gap.

## Verification

| Check | Result |
| --- | --- |
| Targeted data, Chat, Skills, Honeycrisp artifact/editor tests | 561 passed |
| Data evidence suite | 96 passed |
| Svelte data adapter | 17 passed |
| Honeycrisp notes | 5 passed |
| CLI validation | 35 passed |
| Server tests | 157 passed |
| App Shell tests | 39 passed |
| App typecheck, including its data/browser configurations | Passed |
| Honeycrisp script/evidence typecheck | Passed |
| Real Svelte ProseMirror and CodeMirror browser regression | Passed in Chrome |
| Chromium durable-store harness | Passed: reloads, immediate reopen, delayed pending-write loss, committed data retention |
| Standalone port-cost browser bundle | Completed |
| Size benchmark production build | Passed |
| Root-rotation and checkout benchmarks | Completed |
| Executable article storage and update-overhead benchmarks | Completed; standalone typechecks passed |
| Frozen dependency reinstall and module identity audit | Passed |
| `git diff --check` | Passed |

The broader App source run passed 693 tests and failed three
`product-startup.test.ts` cases resolving `wellcrafted/error` or
`wellcrafted/logger`. An isolated checkout extracted from the captured
baseline, with its own frozen RC24 dependency install, reproduced the same
three failures. This is not inferred from unchanged source alone. Logs are
`/tmp/rc26-app-tests.log` and `/tmp/rc26-baseline-startup-clean.log`.

Whole-repository typechecking retains the two failures observed before edits:

- `apps/local-mail/evidence/native-storage.ts`: unused `asPrincipalId` import.
- Honeycrisp `src/routes/[collection=notes]/+page.svelte`: incompatible inferred
  store types at the Notes data prop.

Baseline and upgraded logs are `/tmp/rc26-baseline-typecheck.log` and
`/tmp/rc26-typecheck.log`. App and editor-evidence checks pass independently.

## Review and limits

Two independent reviewers examined the dependency/binding plan. Cumulative
review used one fresh reviewer and one returning independent reviewer because
the task’s agent-thread limit prevented a second fresh reviewer. They retained
the sole-child design and narrowly justified patch, and identified the obsolete
empty conversion helper that was then removed and reverified.

CodeMirror still replaces the supplied body’s whole text per edit; this task
does not redesign its concurrent editing behavior. Raw nodes can reach their
parent/document and are not security sandboxes. Stock Tiptap’s Yjs 13 binding
is not supported. Browser verification covers Chromium/Chrome, not WebKit or
a live authenticated two-device account journey.

Current documentation and the Yjs skill describe the sole-child contract.
ADR-0431 remains Proposed; accepted records preserve their historical text and
link precise layout amendments. The earlier combined-row research report is
explicitly marked historical and not the adopted design.

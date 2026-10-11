# Folder bootstrap iteration

## Outcome

Whispering saves before account or remote setup. Later setup preserves the
folder being edited, and the person can distinguish a saved file, local history,
and a completed cloud transfer.

This pass used computer-use-driven iteration, rethink, and a read-only Claude
Opus 5.5 consultation. It changed one status label and clarified an account
opening gate in ADR-0489. Account startup and cloud transfers remain unbuilt.

## Environment and evidence

On 2026-10-03, the source CLI started this isolated browser instance from the
repository root:

```sh
bun dev:whispering:ui -- --host 127.0.0.1 --port 5297
```

Chrome opened `http://127.0.0.1:5297/`. The checkout contained concurrent
uncommitted work; this was a live-working-tree exercise, not acceptance of an
isolated committed release. The status correction was applied to
`src/lib/status.ts` and verified through Vite's updated UI. The later observed
HEAD was `65c2babebfcc42715f6f1b20f871c7c4a05777e5`; HEAD alone does not reproduce
the exercised app.

No account was signed in. No remote was configured, microphone permission
granted, provider request made, or personal native directory opened.

| Journey | Expected | Observed |
| --- | --- | --- |
| First launch | Open without account setup | The app opened immediately. Folder details named this site's browser storage. |
| New empty transformation | Save local data | The app created `transformations/krps8qrn7i.md`. |
| Edit and reopen | Preserve title, prompt, and filename | After reload, selecting the transformation showed `Local-first setup probe`, `Keep this local test prompt unchanged.`, and the same filename. Its row said `In history`. |
| Another origin | Keep browser storage separate | `http://localhost:5297/transformations` showed no transformations, while `127.0.0.1` retained the saved transformation. |
| Fresh-folder summary | Describe observed history accurately | Before the fix, the summary said `Saved and committed` while details said `No commits yet`. After the fix, the summary said `Saved · no uncommitted changes`. |
| Existing history after the fix | Preserve the file's history indication | The saved transformation still showed `In history` and the same title and prompt. |

The reload demonstrates persistence in that browser origin. It does not
demonstrate native filesystem persistence, account isolation, cloud backup,
microphone behavior, or authenticated Git transport.

## Proposed journey

The person starts recording in Local. Signing in leaves that folder open.
An explicit choice opens the account folder, after unsaved work is settled.
Local recordings stay in Local; opening an empty account folder must say that
clearly. The app does not imply that signing in copied or uploaded anything.

Once an account folder is selected, session expiry or logout must not silently
reopen Local. The selected directory remains available for local editing;
transfers require authentication. A desktop app needs a device-private owner
for this selection. The CLI can continue choosing an account per invocation.
The exact desktop selection API and persistence format are still open.

Connecting a remote configures ordinary Git in the same directory. Fetch,
incoming adoption, and push remain explicit. Independent histories require
reconciliation; matching folder names or origin URLs do not prove matching
content. A browser uses the same logical scope, with storage isolated by
origin. It cannot open `~/Epicenter` as its ordinary browser store.

The radical alternative is moving a Local folder into the account scope when
the destination is absent. That preserves its history, but assigns existing
Local data to an account and changes the established promise that Local stays
Local. This pass does not adopt that alternative. Explicit selection and a
deliberate copy remain the proposed journey.

## Next deciding checks

The next native slice should prove account-shaped root selection and origin
opening against an ordinary test Git server before presenting cloud controls.
Run it with a disposable root, preserving local edits and history. Changing
the selected root must follow the shell's close, which flushes saves in flight,
and relaunch; a page
reload does not release its retained folder owner.

Then exercise expiry and logout followed by reopening, with the selected
account directory still available. The app must not fall back to an empty
Local library. Catalog lookup and authenticated transport need their own
end-to-end evidence before a cloud connection journey can be accepted.

## Review and verification

The status summary already owns severity selection. Changing its clean label
needs no new head-state property, account state, helper, or component. Details
continue reporting the observed branch and commit separately. No cloud status
is inferred from a local commit.

```text
Files read for the status review
src/
|-- lib/
|   |-- status.ts
|   `-- library.test.ts
`-- routes/components/
    |-- AppHeader.svelte
    |-- AppShell.svelte
    `-- SaveStatus.svelte
```

`bun test --isolate apps/whispering/src/lib/library.test.ts` passed: 51 tests,
463 assertions. Browser acceptance covered fresh history and saved history
after the change. The consultation completed without permission denials using
`claude-opus-5-5`; it supplied design advice, not native execution evidence.

## Status corrections after structural review

```text
Files read for the correction review
src/
|-- lib/
|   |-- status.ts
|   |-- status.test.ts
|   |-- library.test.ts
|   `-- page-boundary.test.ts
`-- routes/components/AppHeader.svelte
```

The review reproduced two adjacent errors in the production status helpers:
a failed commit could turn unsaved typing into `Saved · commit failed`, and an
unknown Git observation appeared as `No commits yet`. The correction keeps
file state ahead of history while files are saving or unsaved. Commit warnings
remain in the details and return to the summary after the files are saved.

History now distinguishes an unknown observation from an observed empty
repository. A failed first observation says `History unavailable`. A previous
observation that became stale or failed to refresh says `Last observed`, with
its check time and any refresh error. The existing summary and history helpers
own this presentation; no new state owner, component, or configuration was
added. The shell's folder selection and transfer boundary did not change.

The corrected app was exercised at `http://127.0.0.1:5298/transformations` using
a fresh disposable browser origin on 2026-10-03. The later observed HEAD was
`6d066f8b3d8bd1cb4838a65ec952ba9ceed90ec3`, with the status edits uncommitted.
An observed empty folder still showed `No commits yet` in its history details.
Creating a transformation, pausing autosave, and changing its title showed
`Unsaved typing` in the header. `Save now` returned the header to
`Saved · no uncommitted changes`. Reloading retained the title
`Unsaved status regression probe` in `transformations/mvmlqe2rr1.md`.

The combined commit-failure and unsaved-typing case, unknown history, and stale
history were verified through production-helper tests. They were not injected
into this browser UI; its debug controls expose paused autosave, while native
failure injection requires a desktop shell. This pass establishes no new
native or cloud acceptance.

Verification passed:

- `bun test --isolate apps/whispering/src/lib/status.test.ts apps/whispering/src/lib/library.test.ts apps/whispering/src/lib/page-boundary.test.ts`: 67 tests, 515 assertions.
- `bun run --cwd apps/whispering typecheck`: Svelte and native TypeScript checks.
- `git diff --check` for the status correction.

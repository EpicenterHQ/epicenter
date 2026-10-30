# 0669. Folder actions track lifetime without reserving paths

- **Status:** Superseded
- **Date:** 2026-10-22
- **Superseded by:** [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md).
- **Amends:** [ADR-0664](0664-folder-close-drains-admitted-work-through-one-owner.md) at action admission, path reservations, and close-time editor results. Its one Folder owner and final storage-release boundary remain.
- **Implementation history:** Commit `bd78bfb52b` implemented lifetime-only admission. [ADR-0664's write-only closure amendment](0664-folder-close-drains-admitted-work-through-one-owner.md#amendment-2026-10-22-folder-tracks-writes-not-app-workflows) removes `Folder.run` and its wrappers. The decision and examples below preserve that intermediate model, rather than describe an API to use. The [Folder guide](../../packages/folder/README.md#the-handle) documents the replacement.
- **Relates:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md), retained sources and ordered local publications; [ADR-0663](0663-one-native-question-before-a-window-or-epicenter-leaves.md), native departure policy.

## Context

`run(paths, action)` combined workflow lifetime with saving held input,
reserving paths, and refusing competing input. The retained-source model puts
file commands in each path's own lane and acknowledges only captured input.
A second reservation surface no longer defines publication order.

Workflows still need to finish admitted asynchronous work during orderly
Folder closure. A network answer that arrives after disposal must not infer
permission to save from storage remaining open for a different action.

## Decision

**`folder.run(action)` admits workflow lifetime only.** It accepts no path list,
reserves and locks nothing, and flushes no held input before its callback.
The callback takes no capability argument and uses the ordinary Folder.
Admission occurs at the call, before a callback can notify a listener that
closes the Folder. Once close begins, a new action returns `ActionError.Closing`.

Publication order belongs to each path's command lane. An application that
needs an input save before another operation must request and inspect that
save explicitly; calling `run` does not supply that policy. Admission does
not create an atomic multi-file transaction or protect against outside writers.
A lifetime-only action waiting on a request does not itself mean a file is
saving, so it adds no departure warning.

**Close fences new intent, then releases storage after admitted work drains.**
It synchronously refuses new input, actions, listeners, and `settle()`, submits
held input once, and waits for admitted actions and writes. Repeated calls
share one completion. Ordinary file and table operations remain usable while
close drains and throw only after storage is released. Any caller's write
started during that interval is tracked and prolongs close, not just writes
from an admitted callback.

The handle observes the lifetime registry empty and releases edits and storage
in the same synchronous turn, before its final status notification. An editor
stays readable for recovery, but `save()` after release returns
`SaveRefusal.Closed`. `settle()` and `close()` answer detached recoveries with
path, exact text, and the last save error for input still held.

Callbacks await work whose outcome matters before returning. An unawaited
continuation has no retained capability: storage accepts its write before
release and refuses it afterward. Do not await this Folder's `settle()` or
`close()` inside an action they wait for.

**Product disposal and native departure remain separate.** Whispering admits
the short persistence phase of an answer, each retry, and recording metadata
finalization. New phases refuse after close begins, even if other work keeps
storage usable. Provider waits stay outside the Folder's drain. FolderApp
starts close during teardown; a destroyed WebView or an unloading browser does
not wait for its promise and is not kept alive by `run`.

## Consequences

Remove the path list, save-before-action behavior, reservation conflicts, and
input locks from the public action API. `FolderWork` and per-callback storage
capabilities remain removed. One Folder owns work tracking and final release;
applications own the meaning and ordering of their workflows.

Orderly closure preserves admitted work only while its runtime continues.
It cannot promise a late provider result or duration metadata after native
destruction. Application Quit and window Close retain the policy and evidence
in ADR-0663; this lifecycle change adds no native acceptance result.

## Considered alternatives

- **Keep path reservations in `run`.** This mixes workflow lifetime with file
  coordination and blocks typing even though the path lane orders publication.
- **Restore callback-only storage access.** It distinguishes callers during
  close but duplicates the Folder surface and threads another capability
  through workflows.
- **Close storage immediately.** That prevents admitted asynchronous actions
  from finishing their writes after an await.

## Evidence

<!-- doc-path-check: ignore-next-line -->
`packages/folder/src/handle.ts` owns admission and the final drain/release
<!-- doc-path-check: ignore-next-line -->
boundary. `packages/folder/src/edit-owner.ts` owns publication lanes and held
<!-- doc-path-check: ignore-next-line -->
input. `packages/svelte/src/folder-app.svelte` starts asynchronous teardown;
`apps/whispering/src/lib/runs.svelte.ts` admits result persistence separately
from provider waits. Current contract details live in `packages/folder/README.md`.

# 0643. The Folder package owns its local engine

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at the planned `@epicenter/data` package boundary; [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) at implementation ownership behind its public handle.
- **Implementation:** consolidated into `@epicenter/folder`: one public Folder contract, browser IndexedDB storage, native directory opening, and shared row and merge rules. The former `packages/data` package and declaration-dependent browser opener are removed. See the [Folder README](../../packages/folder/README.md).

## Context

ADR-0636 chooses `@epicenter/folder` as the app API. The newer browser engine
currently lives in `packages/data` and reaches that API through
`@epicenter/data/internal`. The folder package also exports `LocalFolder` for
the newer browser path and `Folder` for the older declaration-dependent path.
No app independently consumes the data package. Keeping that package would
make the implementation boundary look like a second data model and leave two
places to own paths, rows, and merges.

## Decision

**`@epicenter/folder` owns both the app contract and the local engine.** Its
implementation contains shared path, row parsing, and merge rules, plus the
browser IndexedDB, native directory, and Git adapters that use them. Git
exchange is optional to local editing. The finished tree has no
`packages/data`, `@epicenter/data/internal`, or app-facing `Repository`.

**One public `Folder` type represents opened local files in every runtime.**
`openFolder` returns that handle whether a browser selects its origin's local
store or a native app supplies a directory. `Folder.files` and
`Folder.tables` operate on the same rooted files. Storage adapters may differ,
but row interpretation and save merging do not. The finished API has no
parallel `LocalFolder` or `OpenLegacyFolder` type.

## Consequences

- Folder owns the code and tests for its local file and table behavior. A
  package move alone does not satisfy this decision if browser and native saves
  still follow different row or merge rules.
- Apps and the CLI depend on `@epicenter/folder`, not on an internal engine
  import. The current declaration-dependent API and its separate browser
  backend leave the finished surface.
- A future shared package needs a consumer and invariant of its own. Source
  size alone does not justify restoring `@epicenter/data`.

## Considered alternatives

- **Keep `@epicenter/data` as a private engine package.** It has no consumer
  outside Folder and adds a boundary where Folder should own behavior.
- **Keep both `Folder` and `LocalFolder` as public handles.** Apps would have
  to choose between two file and table models for the same local data.

# 0535. An existing folder opens with its own declaration

- **Status:** Proposed
- **Date:** 2026-10-14
- **Amends:** [ADR-0508](0508-folder-opening-overwrites-root-definition-json.md), which overwrites `epicenter.json` from whatever definition opened the folder: only an application's own folder publishes, and only when the bytes differ. [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md), whose one window per folder gives way to any number of windows once the shell compares and publishes every save, under one mutex per root; its cross-process lock stays, one per folder. [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md), whose script example imports `epicenter.json` as a definition, which its shape does not allow.
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (a data folder is a directory with `epicenter.json`), [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (`readFolder`), [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (`epicenter.ts` is the authored source), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) (no automatic commits), [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md).
- **Built:** an unchanged declaration is not rewritten (b3bb9cacb2); scratch names carry their engine and coordination names derive from the root (a5870ca92e); the shell compares and publishes every save, prerequisite 1 below; a folder is registered for several windows and may permit more (`ScopeConfig.windows`, `Folders::permit`), under one cross-process lock per folder; the two openers and `definition` on every handle. `openDataFolder` takes `{ root, git }` in Bun and, until opaque grants exist, `{ id }` naming a registered scope in a desktop page; the browser form opens an origin-private folder by ID, whose first write creates its directory and repository as `openFolder`'s does. The Git lab opens its working copies with it. The shell lists the data folders under the Epicenter folder root for its Folders window (`list_data_folders`): an application's folder through the application's own scope, which the window is permitted into, and any other through a `data:<directory name>` scope registered for that window once per run. The listing returns scope IDs and titles, never paths, though the page still learns each root from the plugin's grant. The Folders window opens each listed folder with `openDataFolder({ id })`, edits its rows by the folder's own declaration, saves every edit at once, and settles a `Conflict` from another window with `mergeRow`, this window's edit winning a field or body lines both changed; a desktop data folder inside another repository never gets its own, as in Bun: the shell names the host at the grant and refuses `git init` there, and never creates a data folder's missing root.
- **Unbuilt:** opaque grants, so a page never receives a root; the persisted grant registry, and its dialog for a folder outside the Epicenter root.

## Context

Every opener takes a definition from code: `openFolder({ id, definition })`
in a page, `openFolder({ root, definition, git })` in Bun. Every handle
publishes that definition to `epicenter.json` just before its first write
(`declaring` in `publish-definition.ts`), at the time of this decision
without comparing. That is right for
an application's own folder, whose schema ships in its code. It is wrong for
a folder whose schema belongs to the folder:

- The Vault keeps its schema in `epicenter.ts` and generates `epicenter.json`.
  A Bun script, or a desktop window, that opened it with any code definition
  would replace that file on its first save.
- The Git lab opens arbitrary working copies with
  `defineFolder({ kv: {}, tables: {} })`
  (`apps/git/src/lib/workspace.svelte.ts`), so its first save publishes an
  empty declaration over the copy's own.

A desktop browser over data folders, the Vault's scripts, and the Git lab all
need to open a folder that already exists, with the schema it already has.
`readFolder` reads one, but cannot write, and runs only in Bun.

Separately, ADR-0531 granted each desktop folder to exactly one window, so a
browser window could not open Todos's folder while Todos was open. Yet `bun.ts` already accepts a script and a window
writing one directory, "kept apart only by Git's lock files and the engine's
checks of the observed version." History is safe between engines: Git's
index is protected by `index.lock`, private index copies are uniquely named,
branches move by compare-and-swap, and ADR-0529 removed the automatic commit
worker. Saves are not. A save's check of the observed version runs in the
page under a lock that covers only its own process or origin, so two engines
can both pass it and the second rename silently replaces the first. Opening
also cleared every file in `.git/epicenter/scratch` under that same narrow
lock, so a second engine could delete another's staged bytes before their
rename, and the lock and channel names included the scope ID, so two openers
of one root with different IDs never coordinated; a5870ca92e fixed both.

## Decision

**Two openers return the same `Folder` handle. The name says who owns the
schema.**

```ts
// An application's own data: named, created on first write, schema from code.
openFolder({ id: 'so.epicenter.todos', definition });

// A folder that already exists: schema from its own epicenter.json, never written.
openDataFolder({ root: '/Users/me/Code/vault' }); // Bun: a path
openDataFolder({ grant });                        // desktop page: a shell-issued grant, never a path
```

| | `openFolder` | `openDataFolder` |
| --- | --- | --- |
| Address | a name the host resolves | a directory a person gave: a path in Bun, a grant in a desktop page |
| Lifecycle | created on first write | must exist; opening creates nothing |
| Schema | the caller's `definition` | the folder's `epicenter.json`, prepared like `readFolder` prepares it |
| `epicenter.json` | published before the first write, only if its bytes differ | never written |
| Types | `Folder<typeof definition>` | untyped rows, checked at run time |

- **Opening an existing folder creates nothing.** A folder with no
  repository has no history until its first commit (Sync or Save version)
  initializes one; a folder inside another repository is refused there
  (ADR-0517).
- **A folder without `epicenter.json` opens with no tables.** Files, history,
  and Sync work; tables do not exist. The Git lab opens working copies this
  way. A caller that needs tables, such as `epicenter check`, refuses
  `NotDataFolder` itself.
- **Every handle exposes `definition`,** the prepared schema it reads with,
  so a grid, board, or SQL view can render a folder it did not declare.
- **History and Sync use the handle's definition.** For `openDataFolder` that
  is the folder's own declaration, so merges validate against the schema
  the folder's other readers use.
- **Only `openFolder` publishes, and only when the bytes differ.** ADR-0508's
  "publish without comparing" is withdrawn; b3bb9cacb2 made `publishDefinition`
  skip a declaration whose bytes already match.
- **`readFolder` keeps its own lifecycle** and shares the parsing and
  table-reading pipeline. It takes no lock, initializes nothing, clears
  nothing, and needs no grant, which an opened handle cannot promise.
- **A typed lens over an existing folder opens it when the folder's
  declaration contains the lens's shape**, never publishing
  ([ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md)).

**Any number of windows may edit a folder, once the shell decides every
save.** Today a save's `Conflict` check compares the expected hash in the
page and then renames (`opfs-store.ts`, under `mutate`, which holds the files
lock). That is atomic only within one lock domain. Two editors in different
domains, such as two origins or a Bun script beside a window, can both see
one hash, both pass, and both rename: the second silently replaces the
first. Saves are not committed (ADR-0529), so the replaced edit is in no
history and cannot be repaired. Git's `index.lock`, the branch
compare-and-swap, and private index copies protect history, not saves. So
many editors need three changes, and the binding goes only after all three.
All three are built:

1. **The shell compares and publishes.** The rename that publishes a staged
   file, and a removal, take `expected`: `"absent"` for a create or a move's
   destination, `"present"` for a replacement without a hash,
   `{ sha256 }` for one with a hash, and `"any"` for an overwrite and the
   declaration. An incoming Sync write carries what the update found at its
   path: the hash of the file it replaces, or `"absent"`; its removals carry
   their hash. The shell checks the path, reading and hashing it when
   `expected` names a hash, and renames or removes under one mutex per
   canonical root, held in its registry and shared by every window of the
   folder (a second scope on one root is refused `Busy`). Every window of the
   shell is then serialized whatever its origin. A save that carries what it
   read (a replacement, removal, or move with a hash, or a create) and that
   another window overtook is `Conflict`, or `Exists` for a create, never
   `Unconfirmed`. An overwrite is last-writer-wins by contract: it replaces
   whatever is there. A move retires its source only if it still holds the
   bytes moved. The cost is one read
   and hash of the target per guarded publish.
2. **Coordination names derive from the canonical root alone** (a5870ca92e),
   so Web Lock names and the hint channel do not include the scope ID, and
   Todos and a browser window on one root share them.
3. **Each engine names its scratch files with its own ID**
   (a5870ca92e), `.git/epicenter/scratch/<time>-<engine>-<n>`, and opening
   clears only names older than any write could still be staging, an earlier
   handle's `<time>-<n>-<random>` names included, so no engine deletes
   another's staged bytes. Names stay one level deep, which the shell's
   write check (`page_files.rs`) already admits.

Then the shell grants a directory to every window registered or permitted
for it, and the quit wait counts every window's admitted work. The shell
keeps one cross-process lock per folder, taken at the first grant from any
window and released at shutdown. It guards against a second Epicenter
process: that process would publish under its own mutex, not this one, so
its saves could replace a window's without `Conflict`. A Bun script remains the one writer the shell does not serialize, as today; a
script that edits a folder a window has open can still overtake it. Windows
of another origin, and other programs, do not receive hints; they read again
on focus and after their own actions (ADR-0529).

**The desktop shell grants directories by registry, not by window.** The
folders under the Epicenter root are listed by finding `epicenter.json`.
Each is named by a scope: an application's folder by the application's own,
since one root takes one cross-process lock and a second scope on it would
be refused `Busy`, and any other by `data:<directory name>`. Coordination
names derive from the root, not the scope (a5870ca92e), so every opener of a
root coordinates whatever scope reached it.
A folder the person picks is opened by the shell's own dialog, recorded so
the grant survives a restart, and returned to the page as an opaque grant.
The page never receives its path.

## Consequences

- The Vault's scripts open the Vault with `openDataFolder({ root })` and use
  table methods, instead of rebuilding the declaration and calling
  `parseRow` and `formatRow` by hand. Its `epicenter.json` changes only
  through `epicenter generate`.
- The Git lab's empty-declaration overwrite is gone by construction.
- A desktop browser can open any data folder, including an application's
  folder while the application has it open, once the shell permits the
  browser's window into that folder (`Folders::permit`).
- Two windows of one folder can overtake each other's saves. A save that
  carries the hash it read sees `Conflict` when it is stale and reads again;
  an overwrite replaces whatever is there, by contract. Views in another origin may be
  stale until focus. A Bun script beside a window is not serialized and can
  still replace a window's save without `Conflict`.
- `openFolder`'s `definition` remains the only way to create a folder, so a
  folder is created only by the application that owns its schema, or by
  `epicenter generate` writing its declaration.
- The cross-process lock stays, one per folder, so a second Epicenter
  process, such as a development build beside a production one, is still
  refused `Busy` while the first has the folder open. Its saves would be
  published outside the first shell's mutex. Letting two processes edit one
  folder would need the comparison under a lock both share.
- The shell gains a persisted grant registry and its dialog; this is the
  largest new piece.

## Considered alternatives

- **One opener with an ownership argument**
  (`schema: { own } | { view } | 'declared'`). Ownership never varies at a
  call site, so the argument encodes a constant, splits the handle's type
  through overloads, and commits the contract to a lens no caller uses.
- **Three openers,** separating file-declared editing from app storage and
  reading. `readFolder` is a reading, not a third ownership.
- **A read grant beside a single write grant,** keeping the lock. It would
  let a browser view an application's open folder without serializing saves
  in the shell, but adds grant kinds and refusals, and still makes a person
  close an app to edit its folder in the browser.
- **Many editors with the comparison left in the page.** Git's locks and
  the branch compare-and-swap protect history, not saves: two lock domains
  can both pass a page-side check and the second rename silently replaces
  the first, outside any history.
- **Reading `epicenter.json` and passing it to `openFolder` as a
  definition.** The folder's schema would become whatever the caller passed,
  and opening would publish it back.
- **An ID derived from the directory's name** for folders opened by path. A
  location already identifies the folder; a derived ID would split
  coordination names, as `basename` does in `bun.ts` today.

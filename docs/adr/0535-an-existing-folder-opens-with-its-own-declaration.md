# 0535. An existing folder opens with its own declaration

- **Status:** Proposed
- **Date:** 2026-10-14
- **Amends:** [ADR-0508](0508-folder-opening-overwrites-root-definition-json.md), which overwrites `epicenter.json` from whatever definition opened the folder: only an application's own folder publishes, and only when the bytes differ. [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md), whose one window per folder and cross-process lock give way to any number of editors once the two prerequisites below land. [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md), whose script example imports `epicenter.json` as a definition, which its shape does not allow.
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (a data folder is a directory with `epicenter.json`), [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (`readFolder`), [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (`epicenter.ts` is the authored source), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) (no automatic commits), [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md).
- **Unbuilt:** all of it.

## Context

Every opener takes a definition from code: `openFolder({ id, definition })`
in a page, `openFolder({ root, definition, git })` in Bun. Every handle
publishes that definition to `epicenter.json` just before its first write,
without comparing (`declaring` in `publish-definition.ts`). That is right for
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

Separately, ADR-0531 grants each desktop folder to exactly one window and
holds a cross-process lock, so a browser window cannot open Todos's folder
while Todos is open. Yet `bun.ts` already accepts a script and a window
writing one directory, "kept apart only by Git's lock files and the engine's
checks of the observed version." Git's index is protected by `index.lock`,
private index copies are uniquely named, branches move by compare-and-swap,
files are staged under fresh names and renamed into place, and ADR-0529
removed the automatic commit worker. Review found one operation that is not
safe between engines: opening clears every file in
`.git/epicenter/scratch` under a lock that only covers its own process or
origin, so a second engine can delete another's staged bytes before their
rename. The lock and channel names also include the scope ID, so two
openers of one root with different IDs never coordinate.

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
  "publish without comparing" is withdrawn; an unchanged declaration is not
  rewritten.
- **`readFolder` keeps its own lifecycle** and shares the parsing and
  table-reading pipeline. It takes no lock, initializes nothing, clears
  nothing, and needs no grant, which an opened handle cannot promise.
- **A typed lens over an existing folder is deferred.** If one is added, the
  folder's declaration stays the authority: opening requires
  `formatDeclaration(definition)` to equal `epicenter.json` byte for byte,
  which `epicenter generate` makes exact, and otherwise refuses.

**Any number of editors may hold a folder.** Two prerequisites make that
safe, and both also fix the script-and-window case that exists today:

1. **Coordination names derive from the canonical root alone.** Web Lock
   names and the hint channel stop including the scope ID, so Todos and a
   browser window on `~/Epicenter/so.epicenter.todos` share them.
2. **Each engine stages under its own scratch directory,**
   `.git/epicenter/scratch/<engine>/`, and opening clears only directories
   no live engine owns, so no engine deletes another's staged bytes.

Then the shell grants a directory to every window that asks for it, holds no
writer lock, and counts admitted work per window for the quit wait. A save
that another editor overtook is `Conflict`, as for any other writer.
Windows of another origin, and other programs, do not receive hints; they
read again on focus and after their own actions (ADR-0529).

**The desktop shell grants directories by registry, not by window.** The
folders under the Epicenter root are listed by finding `epicenter.json`.
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
  folder while the application has it open.
- Two editors of one folder can overtake each other's saves. Each sees
  `Conflict` on a stale save and reads again. Views in another origin may be
  stale until focus.
- `openFolder`'s `definition` remains the only way to create a folder, so a
  folder is created only by the application that owns its schema, or by
  `epicenter generate` writing its declaration.
- Losing the writer lock also lets two Epicenter processes, such as a
  development and a production build, edit one folder. They are two more
  editors under the same rules.
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
  let a browser view an application's open folder, but adds grant kinds and
  refusals in the shell for a lock that review found is not what protects
  the files, and leaves the script-and-window hazard unfixed.
- **Reading `epicenter.json` and passing it to `openFolder` as a
  definition.** The folder's schema would become whatever the caller passed,
  and opening would publish it back.
- **An ID derived from the directory's name** for folders opened by path. A
  location already identifies the folder; a derived ID would split
  coordination names, as `basename` does in `bun.ts` today.

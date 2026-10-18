# 0585. A folder's `epicenter.json` is a description for readers without code

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) (publication by the app a folder is named after, `folder.own`, and the read-through containment check) and [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) (an app opens a folder whose declaration contains its shape; a folder names no app).
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at "the folder's first write, which publishes `epicenter.json` just before it": nothing publishes. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "Only `openFolder` publishes", the typed lens checked by containment, the consequence that `openFolder`'s `definition` is the only way to create a folder, and listing the Epicenter folder by finding `epicenter.json`: nothing publishes or checks containment, a folder is made from a template, and the listing is every real, non-dot directory. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "the app's lens decides" and Whispering's mismatch refusal: rows that do not fit read as invalid rows. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `folder.isOwn`, `runHistory`'s `own?`, `isOwnFolder`, "Publish stays for `epicenter.json`", and `write-epicenter-definition`: each is deleted.
- **Amended by:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at "An app opens the folder it was handed" and "on the desktop the shell decides which folder a window opens (`Folders::hand`, `window_folder`), never the page's URL": an app opens any data folder by id, and the launcher names the first one on the URL. [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at "the `template` commit the approved app commit names", "the one its installed app's approved commit names", and "authored by the app's publisher": no commit is approved and no publisher exists, and ADR-0609 replaces the template commit with files copied once. [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at "The template is the folder's Git upstream", the `template` branch, "A folder's first commit is the `template` commit the approved app commit names", "Update from <app>'s template", `epicenter check <dir>` comparing template commits, and the consequences "until the person updates from the template" and "Every folder's history starts with a commit of its app's `template` branch": a new folder copies its app's `template/` once into a first commit of its own, a data folder's only remote is the person's own, and nothing updates a folder from its app.
- **Amended by:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) at the root `epicenter.json`, its `app` and `title`, and "A data folder is every real, non-dot directory directly in the Epicenter folder": a table is described by its own `<table>/table.json`, which the library never writes on its own, and the unit a person owns is a repository.
- **Amended by:** [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, and its schemas check what it reads and refuse no write.
- **Unbuilt:** `app` in `Definition` and no `title`; a folder that opens when its `epicenter.json` does not read; each app's `template/` directory (ADR-0609; the `template` branch withdrawn) with `epicenter generate` writing its `epicenter.json`; `epicenter new <dir> --from <address>`; "Update from <app>'s template" and `epicenter check` comparing template commits (both withdrawn by ADR-0609); the listing of every real, non-dot directory; and every deletion below.

## Context

`epicenter.json` held a folder's Definition, and code read it to decide who
may write the file and which apps may open the folder.

- **Publication.** An app publishes its Definition into the folder named
  after it (ADR-0583): `opening` sets `own` when the folder id equals the
  app id (`packages/folder/src/opening.ts:43`), and `handleStorage`
  (`packages/folder/src/folder.ts:292`) runs `publishDefinition` and
  `publishLocalPatterns` before the first put (`:314-333`).
- **Containment.** Every other app reads through its definition: `mismatches`
  (`packages/definition/src/shape.ts:73`) refuses a folder whose declaration
  does not contain it, returned as `DefinitionMismatch`
  (`packages/folder/src/open-at-root.ts:130`), and writes are checked
  against the folder's own declaration. A table the app reads but cannot
  fill is `canCreate: false` (`packages/folder/src/table.ts:99`).
- **Listing.** The desktop shell lists a directory in the Epicenter folder
  only when it holds `epicenter.json`
  (`apps/epicenter/src-tauri/src/data_folders.rs:219-220`), and at every
  launch runs `epicenter declare-epicenter-folder`
  (`spawn_epicenter_folder_declaration`, `apps/epicenter/src-tauri/src/cli.rs:597`).

The file also decides how files merge and what a commit leaves out;
ADR-0591 and ADR-0592 take those over. Each of these reads made
`epicenter.json` load-bearing, so it had to be owned and kept current, and
folders had to be named after apps so the owner could be found. With folder
names belonging to people (ADR-0586), the owner rule has nothing to hold
onto.

## Decision

**`epicenter.json` is an optional description for readers without code:**
people, agents, the CLI's `check` and `query`, and the generic editor.

```json
{
  "app": "github.com/EpicenterHQ/todos",
  "tables": { "todos": { "type": "object", "properties": { "title": { "type": "string" } } } }
}
```

- `app` is the address of the app that opens the folder (ADR-0589), so a
  folder cloned onto a machine without the app can offer to install it.
  It is the only link between a folder and an app, grants no rights, and
  nothing rewrites it.
- `tables` is what it is today.
- There is no `title`. A folder's name is its directory name everywhere,
  including where `title` is read today: `DataFolder.title`
  (`apps/epicenter/src-tauri/src/data_folders.rs:120-121`, sorted at `:276`)
  and the folder view's heading (`apps/epicenter/src/folders/FolderView.svelte:118`).

No app writes the file; after a folder is made, only people and agents
change it. Nothing reads it to refuse or rewrite data, so a broken or
missing file damages none. The generic editor validates rows against it
when it reads. When it is missing, the editor shows frontmatter with no
verdict; when it does not read, the folder still opens and the editor shows
the file as text to repair, where `openFolder({ id })` returns
`InvalidDefinition` today (`packages/folder/src/open-at-root.ts:115-122`).

**An app opens the folder it was handed with its own Definition, from its
code.** `openFolder({ definition })` (ADR-0586) validates every table read
and write against `definition` and never reads the folder's
`epicenter.json`. No containment is checked and no refusal replaces it: a
row that does not fit the app's fields reads as an invalid row, for repair,
and a table directory the folder lacks is created by its first row.
`openFolder({ id })` and `openFolder({ root, git })` read `epicenter.json`
when it is there. Of ADR-0583's rules, these stand: each entry exports one
opener, `openFolder`, and on the desktop the shell decides which folder a
window opens (`Folders::hand`, `window_folder`), never the page's URL.

**The template is the folder's Git upstream.** The app's author publishes
a `template` branch in the app's repository (ADR-0589):

```txt
github.com/EpicenterHQ/whispering, branch template
  epicenter.json    generated by epicenter generate from whisperingDefinition; CI runs git diff --exit-code after it
  README.md         written by the app's author: what each table is for, and how to repair a row
  .gitignore        audio/
```

- A folder's first commit is the `template` commit the approved app commit
  names (ADR-0589). `epicenter new <dir> --from <address>` makes the folder
  from it and checks out its files.
- "Update from <app>'s template" merges a newer commit of that branch with
  Sync's three-way merge: the base is the template commit the folder last
  took, so a person's deliberate edits survive and only the template's
  changes arrive. A unit both changed is overridden and listed as in any
  Sync.
- `epicenter check <dir>` says when the folder's newest template commit
  differs from the one its installed app's approved commit names.

**A data folder is every real, non-dot directory directly in the Epicenter
folder.** `epicenter.json` stops being the marker. Each such folder may get
a repository of its own inside another repository's working tree, which an
app's own folder alone could before; a directory anywhere else may not, and
a Bun directory opener always refuses one.

**`epicenter declare-epicenter-folder` is deleted**, and the shell stops
running it at launch; Epicenter keeps no folder of its own (ADR-0587).

## Consequences

- A folder's correctness lives in the code that reads it. A hand-edited
  `epicenter.json` cannot make an app reject or rewrite rows, and an app
  update that adds a field changes no folder file until the person updates
  from the template.
- Every folder's history starts with a commit of its app's `template`
  branch, authored by the app's publisher. Two folders made from one
  template commit share a root commit, so a browser folder and a desktop
  folder that sync to one remote merge with a real base.
- An app handed a folder whose rows do not fit its definition shows them
  as invalid rows; "Todos cannot open the folder 'Recipes'" no longer
  appears.
- Deleted:
  - publication: `publishDefinition`, `publishLocalPatterns`, and
    `PublicationError` (`packages/folder/src/publish-definition.ts`), and the
    `published` option and publish step of `handleStorage`;
  - ownership: `Opening.own` (`packages/folder/src/opening.ts`),
    `Folder.own` (`packages/folder/src/folder.ts:192`), the `own` branch in
    `open-at-root.ts` and `bun.ts`, `isOwn` in `@epicenter/svelte`'s
    `FolderContext` (`packages/svelte/src/folder-context.ts:43`), Todos
    offering Connect only on its own folder, and `runHistory`'s
    `application` option with the CLI's `isApplicationFolder`
    (`packages/cli/src/history-commands.ts:47`), which becomes whether a
    directory sits directly in the Epicenter folder;
  - containment: all of `packages/definition/src/shape.ts` (`Mismatch`,
    `mismatches`, `requiredOutside`, `containment`) and `shape.test.ts`,
    their re-exports (`packages/definition/src/index.ts:47-51`) and README
    section; `DefinitionMismatch` (`packages/folder/src/errors.ts:233`), its
    case in `describeOpenRefusal` (`packages/svelte/src/open-refusal.ts:27`),
    and its branch in `apps/todos/scripts/native.ts:63`; a table's
    `canCreate`, fed by `requiredOutside` (`folder.ts:416`); ADR-0538's
    offer rule; and the tests that assert the refusal
    (`read-through.test.ts`, `handed-folder.test.ts`,
    `tauri-directory.test.ts`, `folder.test-d.ts`, `open-refusal.test.ts`);
  - `title` in `Definition` and `epicenter.json`;
  - `declare-epicenter-folder`, `declareEpicenterFolder`
    (`packages/cli/src/epicenter-folder.ts`), and
    `spawn_epicenter_folder_declaration`.

## Considered alternatives

- **Keep publication by the app a folder is named after.** No folder is
  named after its app once people name folders, and publication rewrites
  whatever a person or agent changed in the file.
- **Synthesize template commits on each device from approved app commits,
  each one's parent the template commit of the previously approved app
  commit.** Two machines that approved different releases would build
  different histories for one template, and folders made on them would
  share no base.
- **A two-way diff against the current template, with each change accepted
  by hand.** With no base it cannot tell a person's removal from a
  template's addition, so it shows every difference for the folder's whole
  life, and accepting all of them reverses a person's edits.
- **Link a folder to its app's template at runtime, refreshing
  `epicenter.json` when the app updates.** It is publication again, with a
  second writer for a file a person owns.
- **Name the app in a trailer on the folder's root commit.** It hides the
  link in history, makes the listing parse Git, and keeps a second place
  for one fact.
- **Fold the description into `README.md` frontmatter.** It collides with
  unrelated READMEs and puts a schema blob atop prose.

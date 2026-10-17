# 0585. A folder's `epicenter.json` is a description for readers without code

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) (publication by the app a folder is named after, `folder.own`, and the read-through containment check) and [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) (an app opens a folder whose declaration contains its shape; a folder names no app).
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at "the folder's first write, which publishes `epicenter.json` just before it": a first write publishes nothing. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "History and Sync use the handle's definition", "Only `openFolder` publishes", the typed lens that opens a folder whose declaration contains its shape, the consequence that `openFolder`'s `definition` is the only way to create a folder, and "The folders under the Epicenter root are listed by finding `epicenter.json`": history and Sync read no definition, nothing publishes, no containment is checked, a folder is made from a template, and the listing is every real, non-dot directory. [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) at "`audio/`, which its definition declares local": Whispering's template `.gitignore` ignores `audio/`. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "the app's lens decides" and Whispering's mismatch refusal: an app opens any folder it is handed, and rows that do not fit read as invalid rows. [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at the unit table's "a row, `<table>/<stem>.md`", "Paths the opened definition declares local never enter a commit", the whole-file merge of `epicenter.json` with its union of `local`, and "Sync, the one write, and the merge driver take the same rule": a `.md` file with readable frontmatter merges by field wherever it is, `.gitignore` decides what a commit leaves out, and every `.json` file, `epicenter.json` included, merges as a whole file, the writer acting winning, and the plain-Git merge driver is deleted. [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) at the `local` key, the engine rule table, `publishLocalPatterns`, and the consequences about `local` merging: audio stays on the machine while the folder's `.gitignore` ignores it, whoever edits that line decides for every device, and Epicenter never refuses to commit a file. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `folder.isOwn`, "`isOwn` is publication eligibility", `runHistory`'s `own?`, `isOwnFolder`, "Publish stays for `epicenter.json` (`publishDefinition`)", and the rename of `declare-epicenter-folder` to `write-epicenter-definition`: each is deleted.
- **Unbuilt:** all of it: the merge by file without a definition, with ours' key order and frontmatter kept as a side wrote it, which tests must prove before it ships (the fallback is restoring row classification); `app` and `source` in `Definition`; a folder that opens when its `epicenter.json` does not read; `template/` in Todos, Capture, Honeycrisp, and Whispering, with `epicenter generate` writing `template/epicenter.json` and CI checking it; template commits synthesized on both backends; `epicenter new <dir> --from <app>`; the folder listing of every real, non-dot directory, which waits on installed apps leaving the Epicenter folder ([ADR-0586](0586-you-open-a-folder-never-an-app.md)); "Update from <app>'s template" as a Sync against a newer template commit, and `epicenter check` saying when a folder's template differs from its installed app's; and every deletion under Consequences.

## Context

`epicenter.json` held a folder's Definition, and code read it to decide
three things.

**How a file merges.** `fileKindOf` and `tableAt`
(`packages/folder/src/merge-file.ts:56`, `:67`) classify a path as a row only
when it is `<declared table>/<id>.md`, one level deep, and `epicenter.json`
itself as the `definition` kind. `rowWins` reads each side with
`parseRow(table)` (`:315`) and writes the result with `writeRow(table)`
(`:321`); a side that fails the table's schema sends the file to a line
merge (`rowTextWins`, `:386`). `writeRow` orders keys by
`Object.keys(table.fields)` through `formatRowSource`
(`packages/folder/src/row-text.ts:147-150`). The validity gate protects
nothing a field merge could break: `check` validates one field at a time
with no rule across fields (`packages/definition/src/prepare.ts:316-342`),
and every merged value comes from ours or theirs, so a field merge of two
valid rows is always valid. The gate only demoted an invalid side to a
coarser merge. The field merge itself needs no table: `mergeRows`
(`packages/folder/src/row-merge.ts:92`) takes rows and returns fields, and
orders keys base, then ours, then theirs (`:106-110`). Sync takes its
classifier from the opened handle (`kindOf`,
`packages/folder/src/git/history.ts:687`); the merge driver walks up from
the path to the nearest `epicenter.json` and prepares it
(`gitMergeKind`, `packages/folder/src/merge-driver.ts:52-76`).

**Who may write the file.** An app publishes its Definition into the folder
named after it (ADR-0583): `opening` sets `own` when the folder id equals the
app id (`packages/folder/src/opening.ts:43`), and `handleStorage`
(`packages/folder/src/folder.ts:292`) runs `publishDefinition` and then
`publishLocalPatterns` before the first put (`:314-333`). Every other app
reads through its definition: `mismatches`
(`packages/definition/src/shape.ts:73`) refuses a folder whose declaration
does not contain it, as `DefinitionMismatch`
(`packages/folder/src/open-at-root.ts:127`), and writes are checked against
the folder's own declaration. A table the app reads but cannot fill is
`canCreate: false` (`packages/folder/src/table.ts:99`), from
`requiredOutside`.

**What a commit leaves out.** `local` in the Definition
(`packages/definition/src/declaration.ts:99`) lists `.gitignore` patterns,
and the engine leaves every match out of every commit whatever `.gitignore`
says (`localMatcher` and `sourceFiles`, `packages/folder/src/git/scope.ts`).
`localNow` (`packages/folder/src/git/history.ts:322`) joins the
Definition's patterns with the file's and refuses a save version or a sync
when `epicenter.json` does not read. `definitionWins` (`merge-file.ts:191`)
unions `local` from both sides. A read-through handle also passes the
reading app's patterns as `appLocal`, which the desktop sends to the CLI as
`--app-local` (`app_local_options` in
`apps/epicenter/src-tauri/src/history.rs`), so Whispering's own status,
save version, and sync of another app's folder commit no audio there. Only
that handle passes them (`createCliHistory` in
`packages/folder/src/tauri-history.ts`): the Folders window's Save version,
the CLI run by hand, and an agent's plain `git` commit the same folder
without them.

The desktop shell lists a directory in the Epicenter folder only when it
holds `epicenter.json` (`apps/epicenter/src-tauri/src/data_folders.rs:219-220`).
At every launch it runs `epicenter declare-epicenter-folder`
(`spawn_epicenter_folder_declaration`, `apps/epicenter/src-tauri/src/cli.rs:597`),
which publishes `so.epicenter`'s Definition.

Each of these reads makes `epicenter.json` load-bearing, so it had to be
owned, published, and kept current, and folders had to be named after apps
so the owner could be found. With folder names belonging to people
(ADR-0586), no folder is named after its app, and the owner rule has
nothing to hold onto.

## Decision

**The merge needs no Definition.** `merge` takes three versions and a path:

| File | Unit |
| --- | --- |
| a `.md` file whose present versions all have frontmatter `parseRowSource` reads | one frontmatter field; one region of body lines |
| a `.json` file, `epicenter.json` included | the whole file |
| other UTF-8 text | one region of lines |
| binary, or a side absent | the whole file |

- No table classifies a path and no depth rule applies: `notes/a.md`,
  `notes/2026/a.md`, and a `README.md` with frontmatter at the root merge
  alike.
- A `.json` file merges whole, the writer acting winning, as
  `epicenter.json` does today, because a line merge joins two different
  insertions at one place (`mergeLines`,
  `packages/folder/src/git/merge-lines.ts:202-209`): two items added to an
  empty array on two devices would merge into JSON with no comma between
  them. The rule is by extension, so it needs no Definition.
- A merged Markdown file keeps its frontmatter as a side wrote it. When the
  merged fields equal ours' fields or theirs', that side's frontmatter bytes
  stand as they are, comments and quoting included. Only when the merged
  fields differ from both sides' is the frontmatter written with
  `formatRowSource`, keys in ours' order, then keys only theirs added.
- A merge that does not format, and a version whose frontmatter does not
  read, takes the frontmatter and body line merge (`rowTextWins`), as an
  invalid row does today.
- Sync and the one write call the same `merge`.

**The plain-Git merge driver is deleted.** Plain Git run on a folder shows
Git's ordinary conflicts; Epicenter's merge by unit runs in Sync, inside the
apps and the CLI. Deleted: `packages/folder/src/merge-driver.ts` and
`packages/cli/src/merge-driver.ts` with their tests, the `epicenter
merge-driver` command, and the configuration written after a connecting
sync (`packages/cli/src/history-commands.ts:238-249`) and after
`epicenter clone` (`packages/cli/src/repository-commands.ts:182-184`).
The command link `~/.local/bin/epicenter` stays, for the credential helper.

**`epicenter.json` is an optional description for readers without code:**
people, agents, the CLI's `check` and `query`, and the generic editor. It
holds:

```json
{
  "app": "so.epicenter.todos",
  "source": { "url": "https://github.com/EpicenterHQ/epicenter", "folder": "apps/todos" },
  "tables": { "todos": { "type": "object", "properties": { "title": { "type": "string" } } } }
}
```

- `app` is the reverse-domain id of the app that opens the folder.
- `source` is the app's Git URL and the folder within it, which the app's
  author writes in the template, so a folder cloned onto a machine without
  the app can offer to install it.
- `tables` is what it is today.
- There is no `title`. A folder's name is its directory name everywhere,
  including where `title` is read today: `DataFolder.title`
  (`apps/epicenter/src-tauri/src/data_folders.rs:120-121`, sorted at `:276`)
  and the folder view's heading (`apps/epicenter/src/folders/FolderView.svelte:118`).

No app writes the file. After a folder is made, only people and agents
change it. Nothing reads it to decide whether data is correct, so a broken
or missing file damages no data. The generic editor validates rows against
it when it reads. When it is missing, the editor shows frontmatter with no
verdict; when it does not read, the folder still opens and the editor shows
the file as text to repair, where `openFolder({ id })` returns
`InvalidDefinition` today (`packages/folder/src/open-at-root.ts:115-122`).

**An app opens a folder with its own Definition, from its code.**
`openFolder({ app, definition })` validates every table read and write
against `definition` and never reads the folder's `epicenter.json`. No
containment is checked at open: a row that does not fit the app's fields
reads as an invalid row, for repair (ADR-0503), and a table directory the
folder lacks is created by its first row. No refusal replaces the check: a
new opening of a folder chooses the app its `epicenter.json` names
(ADR-0586). `openFolder({ id })` and `openFolder({ root, git })` read
`epicenter.json` when it is there. Of ADR-0583's rules, these stand: each
entry exports one opener, `openFolder`; on the desktop the shell decides
which folder a window opens (`Folders::hand`, `window_folder`), never the
page's URL.

**`app` is the only link between a folder and the app that opens it.**
Folder names belong to the person. `app` grants no rights, and nothing
rewrites it. ADR-0583's `app` decided who may write `epicenter.json`; this
`app` decides nothing about writing.

**The template is the folder's Git upstream.** A template is the directory
`template/` in the app's source, beside its `package.json`:

```txt
apps/whispering/template/
  epicenter.json    generated by epicenter generate from whisperingDefinition; CI runs git diff --exit-code after it
  README.md         written by the app's author: what each table is for, and how to repair a row
  .gitignore        audio/
```

Template commits form their own chain, which every device synthesizes from
approved app commits and so builds as the same objects:

```txt
template commit for approved app commit C:
  tree      <C>:<app folder>/template       the approved commit's tree object
  parent    the template commit for the previously approved app commit, or none
  author    "<app title> template", committer the same, date C's committer date
```

- A folder's root commit is the template commit for the approved app
  commit it was made from. `epicenter new <dir> --from <app>` makes it and
  checks out its files.
- "Update from <app>'s template" is Sync's existing three-way merge against
  a newer template commit: the base is the template commit the folder last
  took, so a person's deliberate edits survive and only the template's
  changes arrive. A unit both changed is overridden and listed as in any
  Sync.
- `epicenter check <dir>` says when the folder's newest template commit
  differs from the template of its installed app's approved commit.

**Audio stays on this machine while the folder's `.gitignore` ignores it.**
The engine follows plain Git ignore semantics on both backends, and the
Definition has no `local`. Whispering's template ships `.gitignore` with
`audio/`, so a folder made from it ignores audio from its first byte.
Whoever edits that line decides for every device. A recording committed by
mistake syncs; repairing it means rewriting history in Git, by a person or
an agent, which Epicenter does not do. **Epicenter never refuses to commit a
file.**

**A data folder is every real, non-dot directory directly in the Epicenter
folder.** `epicenter.json` stops being the marker. Each such folder may get
a repository of its own inside another repository's working tree, which an
app's own folder alone could before; a directory anywhere else may not
(ADR-0517), and a Bun directory opener always refuses one.

**`epicenter declare-epicenter-folder` is deleted**, and the shell stops
running it at launch; Epicenter keeps no folder of its own (ADR-0587).

## Consequences

- A folder's correctness lives in the code that reads it. A hand-edited
  `epicenter.json` cannot make an app reject or rewrite rows, and an app
  update that adds a field changes no folder file until the person updates
  from the template.
- Every folder's history starts with a commit authored by its app's
  template, and both backends synthesize template commits. Two folders made
  from one approved app commit share a root commit, so a browser folder and
  a desktop folder that sync to one remote merge with a real base.
- Depth no longer matters to the merge, so nested tables (a note group as a
  real directory, in the open nested-tables spec) merge by field with no new
  rule.
- A field theirs added sits last in a merged row until the app's next save
  of that row moves it: one line of churn in the next commit.
- A hand-written `.md` file with frontmatter outside any table merges by
  field. Its frontmatter is rewritten canonically, losing YAML comments,
  only when both sides changed its fields, as rows already are; history
  keeps the old version.
- A `.json` file both sides changed keeps the writer acting's version
  whole; the other side's edit is in its commit, as with any whole-file
  merge.
- A person or agent running `git pull` or `git merge` on a folder resolves
  Git's ordinary conflict markers.
- An app handed a folder whose rows do not fit its definition shows them
  as invalid rows; no refusal names what is missing, and "Todos cannot open
  the folder 'Recipes'" no longer appears.
- ADR-0577's two engine guarantees end:
  - A `!` line that re-includes audio, or a removed `audio/` line, is an
    edit to the folder's policy. Every device then commits audio, including
    audio recorded before the edit.
  - A file committed before its ignore line stays tracked; the engine no
    longer drops it from the next commit. A folder made from Whispering's
    template never tracks audio, since `.gitignore` is in its root commit.
- No released build reads these folders. A development folder that holds
  committed audio or a `local` key is made again from its template or
  cleaned by hand; no code handles either.
- ADR-0581's storage commands carry no `local` and are unchanged. The
  history commands `status`, `save_version`, and `sync` lose their
  `app_local` argument.
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
  - containment, with no replacement refusal: all of
    `packages/definition/src/shape.ts` (`Mismatch`, `mismatches`,
    `requiredOutside`, `containment`) and `shape.test.ts`, their re-exports
    (`packages/definition/src/index.ts:47-51`) and README section;
    `DefinitionMismatch` (`packages/folder/src/errors.ts:233`), its case in
    `describeOpenRefusal` (`packages/svelte/src/open-refusal.ts:27`), and
    its branch in `apps/todos/scripts/native.ts:63`; a table's `canCreate`
    (`packages/folder/src/table.ts:99`), fed by `requiredOutside`
    (`folder.ts:416`); ADR-0538's offer rule; and the tests that assert the
    refusal (`read-through.test.ts`, `handed-folder.test.ts`,
    `tauri-directory.test.ts`, `folder.test-d.ts`, `open-refusal.test.ts`);
  - classification: `FileKind`, `fileKindOf`, `tableAt`, the `definition`
    merge kind with `definitionWins` and `localPatterns`, and `kindOf` in
    `git/history.ts`;
  - the merge driver, as listed above;
  - `title` in `Definition` and `epicenter.json`;
  - `local`: the key in `Definition` and its checks in `prepareDefinition`,
    `localMatcher` and `sourceFiles`' `isLocal` and `isAppLocal`
    (`packages/folder/src/git/scope.ts`), `localNow` and its refusal,
    `appLocal` through the openers, `--app-local` in the CLI, and
    `app_local_options` with each history command's `app_local`;
  - `declare-epicenter-folder`, `declareEpicenterFolder`
    (`packages/cli/src/epicenter-folder.ts`), and
    `spawn_epicenter_folder_declaration`.

## Considered alternatives

- **Keep the Definition in the merge.** Its only effect was demoting an
  invalid side to a line merge; it tied rows to one directory level, which
  nested tables break, and made the merge driver find and prepare a file.
- **Keep the plain-Git merge driver.** It needs configuring per clone and a
  working command link, and it gives plain Git a second conflict policy
  beside Git's own, for merges Epicenter's Sync already makes by unit.
- **Keep publication by the app a folder is named after.** No folder is
  named after its app once people name folders, and publication rewrites
  whatever a person or agent changed in the file.
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
- **Template lines in `.gitignore` the engine refuses to let a person
  override.** The engine would have to remember which lines came from a
  template, which is the `local` key under another name.
- **A reserved `local/` directory the engine never commits.** An exception
  Epicenter invented, which plain `git` needs a `.git/info/exclude` line to
  follow; and "local" names nothing in a local-first product, where every
  file is local.
- **A `.nosync` suffix.** Another invented exception, and renaming a file
  changes whether it syncs.
- **`.git/info/exclude`, alone or written per recording beside the
  template's line.** It is a second, per-device policy that overrides the
  folder's, which is the `local` key again; and alone it does not travel
  with a clone.
- **A check before recording that `audio/` is ignored and untracked.** The
  line is the folder's policy, and a check at record time would override a
  change its owner made.
- **Audio in app data, outside the folder.** It breaks ADR-0544's rule that
  a blob is a file in its folder, and separates a recording's audio from its
  row.
- **Leave binaries out by kind.** A PDF a person drops into a folder would
  silently not sync.
- **Leave large files out by size.** Any threshold is arbitrary, and a file
  that grows past it stops syncing without a word.

# 0517. A data folder can live inside any repository

- **Status:** Proposed
- **Date:** 2026-10-11
- **Amended by:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) at executing a declaration: `epicenter generate` may run a folder's `epicenter.ts` on request; readers still read only `epicenter.json`.
- **Relates:** [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) (queries build transient projections), [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) (a private repository per synced folder), [ADR-0521](0521-a-data-folder-syncs-with-its-git-origin-through-a-provider.md) (sync with the Git origin), [ADR-0490](0490-the-cli-discovers-folders-and-delegates-history-to-git.md) (discovery lists repositories), [ADR-0508](0508-folder-opening-overwrites-root-definition-json.md) (opening publishes the declaration), [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) (a folder is the directory its ID names)
- **Unbuilt:** discovering data folders by `epicenter.json` in apps, opener refusal of a root inside another repository, extraction tooling, and opening a submodule-hosted data folder in the native engine.

## Context

ADR-0532 gives one dataset one stable directory containing its files and Git
history, and ADR-0488 names each dataset by a folder ID paired with one
repository. Together they treat a data folder as one directory, one Git
repository, and one folder ID. That equivalence serves app sync: transfers,
ownership locks, history adoption, and repository-scoped credentials all
operate on one repository.

It also prevents adding structured Markdown to a repository that already
exists. A personal vault, a project repository, or a team repository can hold
a publishing plan that people and agents edit as files and query with SQL.
Requiring a separate repository first makes that plan harder to start, and a
separate repository buys nothing until an app needs to open it.

## Decision

**A data folder is any directory containing `epicenter.json`.** The file
declares the table directories (`<table>/<stem>.md`) and the `kv.json` beside
it. It claims nothing else: other files and directories beside it are ordinary
files. A Git repository may contain any number of data folders at any depth.
A directory declared as a table must not contain its own `epicenter.json`.

**`epicenter.json` is JSON and is only read.** No reader executes a file to
learn a data folder's declaration, because a data folder may arrive in any
cloned repository. The filename alone marks a data folder, the way
`package.json` marks a package.

**Each table and `kv` is a JSON Schema object.** A tool that knows JSON Schema
can check a row against its table without knowing Epicenter.

```json
{
  "title": "Plan",
  "kv": { "type": "object", "properties": { "theme": { "enum": ["light", "dark"] } } },
  "tables": {
    "posts": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "queuedAt": { "type": "string", "format": "date" }
      },
      "required": ["title"]
    }
  }
}
```

- Top level: optional `$schema` and `title`, then `kv` and `tables`.
  `$schema` is for editor completion and never interpreted.
- A table: `"type": "object"`, `properties`, and optional `required`. Each
  property is one field as ADR-0525 defines it. `required` names each
  required field once, and a table without it has only optional fields
  (ADR-0526).
- `kv`: `"type": "object"` and `properties`, with no `required`, because
  every setting may be unset.

`formatDeclaration` and `parseDeclaration` in
`packages/folder/src/declaration.ts` are the only code that writes or reads
this shape. `parseDeclaration` refuses an unknown key at the top level or in
a table or `kv` object, a `required` entry that names no property, and a
visible `~` key in a field. `prepareSchema` then refuses what ADR-0525
refuses, such as a `format` outside TypeBox's stock set. Readers do not check
the schema language itself: a misspelled keyword such as `minimun` is
ignored, as JSON Schema ignores any unknown keyword.

```text
vault/                            host repository
  plan/                           data folder
    epicenter.json                declares accounts, posts, and kv
    kv.json
    accounts/instagram.md
    posts/2026-10-14-reel.md
  crm/                            another data folder in the same repository
    epicenter.json
    people/alex.md
  journal/                        no epicenter.json: ordinary files
```

**Reading and querying need no repository of their own.** A data folder inside
a host repository is edited as ordinary files and recorded in the host's
history. Queries build an in-memory projection from the current files under
ADR-0494; nothing persists a database beside the data folder.

**App sync requires a data folder at a repository root.** Apps transfer,
lock, and receive credentials per repository (ADR-0488). An app never holds
credentials to a host repository in order to reach a data folder inside it.
Discovery lists repositories (ADR-0490); data folders inside a repository are
found by their `epicenter.json`, not registered. ADR-0532's one-directory rule
applies to repository-root data folders, which sync with their Git origin
(ADR-0521). A hosted data folder's address is its host repository and its path
inside it.

**A hosted data folder moves to its own repository by extraction.** Split its
history out of the host into a new repository, remove the directory from the
host, and add the new repository back at the same path as a submodule. Leave
`ignore` unset so the host's status shows when the recorded commit falls
behind. Extraction keeps each commit's whole message, so a commit that touches
a hosted data folder touches nothing else.

```sh
git subtree split --prefix=plan -b plan-only
# create the new repository and push plan-only to it as main
git rm -r plan
git commit -m "Move plan to its own repository"
git submodule add <repository-url> plan
```

## Consequences

- Any repository adopts a data folder by adding `epicenter.json` and its
  table directories. No Epicenter command, marker, or separate history is
  required.
- A hosted data folder's history belongs to the host until extraction. Split
  history has new commit IDs; the host keeps the original commits.
- After a fresh `git clone --recurse-submodules`, the submodule sits at the
  recorded commit with a detached HEAD. A setup step switches it to `main` and
  pulls. Plain `git clone` leaves the directory empty, and the
  `submodule.recurse` setting does not apply to `clone`.
- The Bun and Tauri openers do not recognize a hosted data folder. Given its
  directory, they stop Git discovery at that directory and run `git init`
  there, creating a nested repository inside the host. Do not open a hosted
  data folder with them until they refuse a root inside another repository's
  work tree.
- A submodule's `.git` is a `gitdir:` file. Both openers refuse that layout
  (`verifyNativeLayout` and the Rust `verify_layout`), so an app on the same
  machine opens its own clone of the extracted repository until
  submodule-hosted data folders are supported.
- If the host is itself an app-opened data folder, the engine refuses
  whole-folder commits once it contains a submodule. Extract only from hosts
  that people and agents commit with ordinary Git.
- The CLI's `check` and `query` read `epicenter.json` (ADR-0520); apps do not
  yet. What `formatDeclaration` writes reads back through `parseDeclaration`
  and `prepareSchema` as the same definition.
- A declaration in the earlier shape, where a table was
  `{ "fields": { ... } }`, is refused. There is no migration; opening an app
  on the folder rewrites the file in the current shape.
- The key set and the portable formats are closed, so a reader refuses a
  declaration from a newer writer that adds either. Adding one is a reader
  change first.
- Openers publish `epicenter.json` (ADR-0508), so an app-opened data folder
  is discoverable by it. A `definition.json` left by an older build is an
  ordinary file the folder no longer reads or writes. A hosted data folder
  that no app opens keeps the `epicenter.json` its authors wrote. Opening
  an app replaces it: the app that opens the folder is assumed to hold the
  current definition, and the file always describes the last opener. A
  hand-written declaration is for folders that no app owns, read through
  `readFolder`.
- Two builds that declare differently rewrite the file each time either
  opens, so the history shows the declaration moving back and forth. No
  version number keeps the newer one; if that churn appears in practice, a
  monotonic declaration version is the first fix to consider.
- `readFolder(root)` from `@epicenter/folder/bun` reads a data folder without
  opening it: the prepared declaration, each table's `list()`, and
  `kv.get()`, through the opener's native file boundary. It writes nothing,
  so it reads a folder nested in any repository.

## Considered alternatives

- **Opening reads an authored `epicenter.json` and refuses or goes read-only
  when the app cannot read the folder.** Protects a hand-written declaration,
  but makes the file a second authority beside the app's code and adds a
  compatibility verdict to every open.
- **A declaration version, where the higher one wins.** Stops an older build
  from rewriting a newer declaration, at the cost of a version every app
  must bump correctly. Deferred until the churn is real.

- **One definition per directory of rows.** Each `epicenter.json` would
  describe only the `.md` files beside it. Related tables would split across
  files, and `kv.json` would have no declaration.
- **Apps sync a nested data folder through its host repository.** The app
  would need credentials to the whole host and would merge files it does not
  understand.
- **An ignored inner repository instead of a submodule.** The host cannot
  restore it on clone, and ripgrep, which agents use to search, skips ignored
  paths.
- **A subtree as the lasting arrangement.** It keeps two histories of the same
  files and a merge step that someone has to own.
- **`definition.json`.** Other tools use the name, so discovery would need a
  content check to tell an Epicenter declaration apart.
- **`epicenter.config.ts` or `epicenter.config.json`.** An executable
  declaration runs a cloned repository's code to read its data, and "config"
  names tool settings rather than a data declaration.
  ADR-0527 keeps `epicenter.ts` as a source that `epicenter generate` runs on
  request; readers still read only the JSON.
- **A separate repository from the start.** It requires a pointer, a setup
  step, and engine support for submodules before any app needs them.

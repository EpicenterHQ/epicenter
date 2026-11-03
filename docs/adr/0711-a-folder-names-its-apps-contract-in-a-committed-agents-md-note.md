# 0711. A folder names its app's contract in a committed AGENTS.md note

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at decision 35 ("folders hold no `epicenter.json`") and at `epicenter init --contract` in its Unbuilt line: a folder holds an `AGENTS.md` note naming its contract URL, and `init` records no contract in Git configuration.
- **Unbuilt:** the app writing `AGENTS.md` at first open; the CLI's generated block in it; `epicenter check` and Epicenter reading `contract` from it; the deep link `epicenter://init` writing the note when it is missing.

## Context

Nothing a folder carries says which app made it. `epicenter check` takes the
contract as an argument, a URL or a file (`packages/cli/src/contract-commands.ts`),
citing decision 35: folders hold no `epicenter.json`. The deep link
`epicenter://init?path=…&contract=…` (`packages/folder/src/epicenter-sync.ts`)
carries the contract URL to Epicenter, which displays it and stores nothing
(`FolderSetup.contract`). ADR-0700 lists `epicenter init --contract` as
unbuilt.

Decision 35 removed a file that `epicenter generate` wrote from code: a copy of
the schema that drifted from the app's real contract (ADR-0700, Context). A
second device, an agent opening the folder, or a clone from a plain Git host
has no way to learn the folder's app.

## Decision

**A folder's root holds `AGENTS.md`, a note whose front matter names the contract's URL.**

```markdown
---
contract: https://whispering.epicenter.so/contract.json
---
<!-- BEGIN epicenter (managed by Epicenter; edit outside this block) -->
This folder is Whispering's data. Recordings are `recordings/<id>.md`, with
their audio beside them as `recordings/<id>.<ext>`. Check changes with
`epicenter check`.
<!-- END epicenter -->

Anything the person writes here stays.
```

- **`contract`** is the only field. It holds a URL, never a copy of the
  schema. The app's published `contract.json` stays the one description.
- **The contract URL leads to the app's identity, its site's origin.** A
  folder's name is its slug ([ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md)), which two apps may share and a
  person may change; the origin is globally unique and survives a rename. The
  app's site describes the app further ([ADR-0717](0717-an-epicenter-app-is-a-site-that-publishes-a-contract.md)).
- **The app writes the note at first open** of a folder that lacks one,
  with its own contract URL (the constant it already passes to
  `syncWithEpicenter`).
- **The CLI keeps the generated block current**, replacing only the text
  between its markers, the pattern `withEpicenterBlock` uses for
  `.gitignore` and `.gitattributes` (`packages/cli/src/sync/managed-block.ts`).
  Text outside the block is never changed. The markers are HTML comments,
  since the `# BEGIN epicenter` lines those files use
  (`EPICENTER_BLOCK_BEGIN`) are headings in Markdown.
- **Readers take the contract from the note.** `epicenter check` with no
  contract argument reads it; Epicenter reads it to label a listed folder
  ([ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)) and to find the app's site on a new device. `clone` names
  the folder by the repository name and does not read the note.
- **`epicenter init` records no contract in Git configuration.** The
  deep link's `contract=` writes `AGENTS.md` only when the folder has none.
- **A folder without the note is a plain folder.** Epicenter may ask "Which
  app is this folder for?" and does not require an answer; answering writes
  the note.

The note is a `.md` file at the folder root, so the merge settles it key by key
and body by lines ([ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md)), it never goes to LFS, and it travels with every
clone, mirror, and zip download. Agents that read `AGENTS.md` from the working
directory up to the repository root find it when opened inside the folder.

## Consequences

- One committed file per folder. Two devices that create it before their
  first sync merge it as one note: `contract` is equal on both, and the body
  blocks merge by lines.
- A person can delete or edit the note. Deleting it makes the folder a plain
  folder again; editing `contract` to another URL changes what `check`
  validates against.
- A contract `collections` entry must not claim `AGENTS.md`; `check` treats
  it as the folder's own file, outside every collection.
- `epicenter check <dir>` works with no contract argument; the argument
  remains for checking against a draft contract.

## Considered alternatives

- **A column on the server's `repository` row.** Readable only through
  Epicenter's server; a repository on another Git host loses the link.
- **A Git ref, `refs/epicenter/app`, pointing at a commit holding the URL.**
  Travels with Epicenter's own clone, but a plain `git clone`, a zip
  download, and branch-only mirrors drop it, and agents cannot read it with
  file tools.
- **`epicenter.contract` in the folder's local Git configuration.** Stays on
  one computer.
- **`epicenter.json` holding the URL.** A second format beside the notes,
  while `AGENTS.md` also orients agents.

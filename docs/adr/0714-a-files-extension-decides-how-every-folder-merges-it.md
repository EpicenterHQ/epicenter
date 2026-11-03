# 0714. A file's extension decides how every folder merges it

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "every file that is not a `.md` note and not a hidden path is Git LFS": text files other than notes merge as text, and only other files and oversized text are Git LFS.
- **Unbuilt:** the text-extension list and size cap in `REPOSITORY_ATTRIBUTES` and `storedWithLfs`; the server's check of the cap; the starter `.gitignore` for plain folders; the warning for a database file.

## Context

`REPOSITORY_ATTRIBUTES` in `packages/definition/src/contract/storage.ts` writes
one rule into every synced folder's `.gitattributes`:

```txt
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* (hidden paths)  !filter !diff !merge !text
```

`storedWithLfs(path)` in the same file is `!isHiddenPath(path) && !isNotePath(path)`,
and the server refuses a write that breaks it (`packages/server/src/routes/files.ts:194`,
`packages/server/src/git/lfs-rule.ts`).

That fits a folder an Epicenter app made, where every non-note file is audio or
an image beside its note. Epicenter now syncs any folder a person adds,
including folders other programs made ([ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)). An Obsidian vault holds
`.canvas` and `.json` files, and other folders hold `.txt`, `.csv`, and `.yaml`.
Under the current rule each becomes an LFS pointer that cannot merge: two
devices editing one `.csv` produce a conflict copy instead of a line merge.

## Decision

**Every folder Epicenter syncs uses one rule, chosen by the file's extension.**

| File | Stored | Merges with |
| --- | --- | --- |
| `*.md` | Git text | `settle`: front matter key by key, the body by diff3 (`packages/definition/src/merge/settle.ts`) |
| a text extension (`.txt`, `.json`, `.csv`, `.yaml`, `.yml`, `.toml`, `.canvas`, and the rest of a fixed list) under the size cap | Git text | Git's line merge |
| any other file, and a text file over the size cap | Git LFS | the existing binary rule: compare-and-swap, the loser lands as `<stem> (conflict <hash7>)<ext>` (`conflictSibling`) |
| a hidden path | Git, untouched | Git's defaults |

- **The rule does not depend on the folder's kind.** A folder an Epicenter app
  made and a plain folder, such as an Obsidian vault, get the same
  `.gitattributes` block. Whispering's `recordings/<id>.webm` is not a text
  extension, so it stays in LFS.
- **`storedWithLfs(path)` follows the same table**, so the server and the
  desktop agree on which writes must carry an LFS pointer.
- **A plain folder gets a starter `.gitignore`** when `epicenter init` adopts it:
  `.DS_Store`, common cache directories, and Obsidian's `.obsidian/workspace.json`.
- **Epicenter warns when a folder holds a database file** (`*.sqlite`, `*.db`)
  before adopting it, since a database cannot merge and changes while its
  program runs.

The size cap's value is not chosen yet.

## Consequences

- A `.json` or `.csv` edited on two devices merges line by line, with conflict
  markers where lines overlap, instead of producing a conflict copy.
- Two folder kinds need no separate rules, attribute blocks, or server checks.
- The text-extension list is a durable format: a folder synced under one list
  and read under another stores the same file two ways. Changing the list later
  needs a migration of affected files.
- Conflict markers can now land in `.json` files, which then fail to parse until
  a person or agent repairs them. Notes already behave this way for their bodies.

## Considered alternatives

- **Keep every non-note file in LFS.** Breaks merging for every text file in a
  plain folder.
- **One rule for Epicenter-shaped folders and another for plain folders.** Every
  sync, the server, and the Epicenter app would need to know a folder's kind.
- **Decide by content (a NUL byte) instead of extension.** The server would read
  every file's bytes to choose its storage, and a file could change storage
  between commits as its content changes.

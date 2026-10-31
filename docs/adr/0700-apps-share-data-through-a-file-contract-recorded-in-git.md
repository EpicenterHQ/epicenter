# 0700. Apps share data through a file contract recorded in Git

- **Status:** Proposed (awaiting the owner's review; flip to Accepted when approved)
- **Date:** 2026-10-31
- **Supersedes:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (one merge where the change wins and no conflict marker is written), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (a Git clone per web origin), [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) (browser sync), and [ADR-0545](0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md) (the hosts' incoming-update engine).
- **Amends:** the 23 records in [Records this changes](#records-this-changes), each at the scope named there.
- **Unbuilt:** per-repository grants and the consent page choosing a repository (`openRemote` reaches `<account>/<contract name>` until then); `@epicenter/secrets`; the notify Durable Object that broadcasts "main moved" per repository; Whispering's migration to a contract; `epicenter init --contract`; an R2 bucket bound to the production `api` Worker.

## Context

Before this, two engines ran Git. Each web origin kept its own isomorphic-git
clone in IndexedDB and synced it (`browser/sync.ts`, ADR-0623, ADR-0628). The
desktop committed through a native history engine in
`packages/folder/src/git/` (`hash-object --no-filters`, `epicenter history`,
`save-version`, `sync --to`). Both ran one TypeScript merge in which the change
won and nothing wrote a conflict marker (ADR-0622). Every `filter=` and
`merge=` attribute was refused, so audio could not travel (ADR-0621). Hosted Git
refused every push that was not a fast-forward (ADR-0620). `epicenter check`
read a folder's `epicenter.json`, which `epicenter generate` wrote from code
(ADR-0520, ADR-0585).

That design had two writers of history per person, binary files with no path
into the repository, and a browser that held a copy of every repository it
touched. Stock `git`, `git-lfs`, and an agent could not take part without
learning Epicenter's engine.

## Decision

**An app's data is a layout of files that a contract describes, and Git is the
record of that layout.** Any program that writes the layout is a valid writer.
A contract is plain data written with `defineContract`
(`@epicenter/definition/contract`) and published as JSON:

```txt
{ name: 'recorder-demo',                     lowercase slug; the repository is <account>/<name>
  collections: {
    recordings: { path: 'recordings/{id}.md',  .md: a note (front matter fields plus body)
                  fields: { title: { type: 'string' } }, required: ['title'] },
    audio:      { path: 'recordings/{id}.{ext}' } } }   any other extension: a file
```

Fields are JSON Schema. Placeholders are required arguments to `create`;
nothing mints them (`timeId()` and `nanoid()` come from
`@epicenter/definition/ids`). A contract derives one typed client, `Client<T>`:
`list`, `get`, `create`, `update`, `delete`. Each `update` and `delete` carries
`over`, the version it read. Refusals are `ClientError`: `NotFound`,
`Occupied`, `Conflict { current }`, `Invalid`, `Unavailable`. Paths with a
segment starting with `.` are outside every contract (`isHiddenPath`).

**Apps own data; Epicenter owns history.** Apps write files and never commit.
On the desktop, `epicenter sync` is the only committer, and it commits with
real `git add` so Git LFS's filters run. On the web, the server commits each
write. A folder `epicenter init` has not registered has no history.

**The web never syncs.** A web app keeps its own files in the browser, or
reads and writes the repository through the server while online:

| Opener | Entry | Where | A version is |
| --- | --- | --- | --- |
| `openDevice(contract)` | `@epicenter/folder/browser` | the origin's OPFS, through one Worker, a Web Lock per path | sha256 of the bytes |
| `openDevice(contract, { path })` | `@epicenter/folder/node` (Bun) | a directory, under the save lock | sha256 of the bytes |
| `openDevice(contract, { path? })` | `@epicenter/folder/tauri` | the directory the shell bound to the window (`path`: a folder inside it), under the save lock | sha256 of the bytes |
| `openRemote(contract, { account })` | `@epicenter/folder/remote` | `<git audience>/~/<contract name>.git`, every request through `account.fetch` | the Git blob id on `main` |

A file made in the browser stays in OPFS with a capture sidecar
(`.epicenter/outbox/<id>.json`). `startUploading(device, remote)` uploads it
once signed in and online: the LFS object, then one write carrying its
`captureId`. The local copy is deleted only at the version the receipt shows
landed; a later edit is queued as an update. Edits and deletes of repository
files are online only.

**The server translates writes and receives pushes; it holds no data of its
own.** Both live in `mountGitHost` (`packages/server/src/routes/git.ts`):

- The translator, `POST <repo>.git/epicenter/writes` (`routes/files.ts`), reads
  `main`, settles each file, builds one commit per request, and moves `main`
  by compare-and-swap, retrying up to 12 times. A capture's receipt is
  `refs/epicenter/captures/<id>`, moved with `main` and hidden from clients; a
  replay is checked against `main`, which is the truth.
- The receiver (`routes/receive.ts`) accepts `refs/heads/main` alone and no
  delete. It decides fast-forward from the pushed commits, accepts merge
  commits, and checks every commit `main` does not reach. Every changed file
  that is not a `.md` note or a hidden path must be a Git LFS pointer whose
  object is stored (`storedWithLfs`), whatever `.gitattributes` says.
- Only the owner (the `rewrite` role) may replace `main`. The replaced tip is
  kept at `refs/epicenter/replaced/<time>` in the same transaction. Everyone
  else moves `main` forward only. `epicenter sync` stops when the remote `main`
  no longer contains `refs/epicenter/last-seen`.

**Every file in a data folder except a note and a hidden path is Git LFS, with
its bytes in R2.** `REPOSITORY_ATTRIBUTES` (`@epicenter/definition/contract`) is
the `.gitattributes` block `epicenter init` commits and the server writes in a
repository's first commit; `REPOSITORY_IGNORE` keeps `.DS_Store` and
`.epicenter/` out. On Cloudflare, Git lives in Artifacts and LFS objects in R2
(`createR2LfsStore`): clients upload through presigned URLs that sign
`content-length`, `if-none-match: *` and `x-amz-checksum-sha256`, and an object
is admitted after one `head()` matches its size and sha256. On Bun, both stores
are on disk.

**Notes merge by one set of rules, wherever a merge runs.** `settle` in
`@epicenter/definition/merge` runs in the translator and in
`epicenter merge-driver %O %A %B %P`:

| Both sides changed | Result |
| --- | --- |
| a front matter key | the later arrival at the server wins, with no block; the other value stays in history |
| the body, at different lines or words | both changes kept |
| the body, at the same spot | one conflict block of whole lines |
| one side edited, the other deleted | the edit |
| a binary file, replaced on both sides | the earlier stays; the later lands beside it as `<stem> (conflict <hash7>).<ext>` |

Whatever an Epicenter tool writes is in house style: schema keys first, then
sorted, block YAML, body untouched. On the desktop the later arrival is `%A`
under a merge and `%B` under a rebase.

**The CLI is the desktop's interface to history.** Every verb is in
`packages/cli/src/commands.ts`:

```txt
epicenter init [<dir>] [--enclosing-ok]   set up or repair; register for sync
epicenter clone <ns>/<name> [<dir>]       git clone, then init
epicenter sync [<dir>] [--watch]          commit, fetch, merge, git lfs push, push
epicenter status [<dir>]
epicenter forget [<dir>]
epicenter check <contract> [<dir>]        contract as a URL or a file path
epicenter format <contract> [<dir>]
epicenter merge-driver %O %A %B %P        hidden; Git runs it
```

`sync` exits 0 when synced, 1 to run again, and 2 when stopped for a person or
an agent. A folder links to a repository with plain
`git remote add origin <url>`; the first push creates the repository.

**Desktop Git features may assume an agent; the web assumes nothing.** A
person who reached Git has an agent that fixes its own conflicts, locks, and
rejected pushes, so `sync` stops with exit 2 and leaves Git's state for it. The
web offers only what needs no repair: create while offline, edit and delete
while online, with `Conflict` answered in the app.

**Deleted:** `epicenter generate` and `generate-declaration.ts`;
`epicenter history`, `save-version`, and `sync --to`; the native history engine
(`history`, `native-backend`, `native-checkpoint`, `merge`, and `sync` in
`packages/folder/src/git/`, which keeps only the `git` runner and the browser
storage's object reader); browser sync
(`browser/sync.ts`, `browser/git/transfer*`, `browser/git/publication.ts`) and
the `isomorphic-git` dependency of `@epicenter/folder`; `publishFile`.

## Consequences

- A desktop clone needs `git` and `git-lfs`. A clone without the driver or the
  LFS filters is refused by `sync` and, for raw bytes, by the receiver.
- A web write measured p50 2.3 s and p95 3.2 s on Artifacts, almost all of it
  waiting on Artifacts. A push into a flat folder of 5,000 files took 9.9 s;
  partitioning a layout is an app's option.
- Artifacts caps a repository at 1 GB of Git data; LFS bytes in R2 do not
  count. R2 bytes of deleted files are not collected yet.
- A front matter value that loses a race is visible only in history.
- A version means sha256 on a device and a Git blob id on a remote. A receipt
  carries blob ids, and the outbox compares them with its own bytes.
- A repository grant exposes every data folder in that repository.
- The production `api` Worker routes every push through the receiver, so it
  must not deploy until an R2 bucket is bound (`apps/api/README.md`).
- The IndexedDB `openFolder` engine remains for the apps that have not moved to
  a contract. `epicenter query` and `schema import|export` still use a legacy
  root `epicenter.json`.

## Considered alternatives

- **A Git clone per web origin** (ADR-0623, ADR-0628): every origin was a
  separate copy to sync, and binary files had no way in.
- **A live sync engine with a browser replica** (`claude/repository-v2`): a
  second record beside Git that stock tools and agents cannot read.
- **A conflict block for front matter:** a note must always parse.
- **The server formatting by contract:** the client formats before sending, so
  the server needs no contract and keeps the incoming key order.

## Records this changes

| Record | Amended at |
| --- | --- |
| [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md) | `folder.git.commitAndPush()` and refusing attribute transformations: apps never commit, and `epicenter sync` commits with LFS filters. |
| [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) | the `git` member: a folder handle has no history operations. |
| [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) | `epicenter check <dir>` reading `epicenter.json`: `check` and `format` take a contract; `sync` exits 1 to run again and 2 when stopped. |
| [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) | "when a person saves a version" and `folder.git.commit()`: only `epicenter sync` and the server commit. |
| [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) | history through `run_git` and `hash-object -w`: the page has no history. |
| [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) | `folder.sync.connect(url)`: a remote is set with `git remote add origin`. |
| [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md) | the history column and `epicenter generate`: no host runs Git for a page. |
| [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) | `epicenter generate` writing the declaration: generation is deleted. |
| [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) | refusing every non-fast-forward and a browser's token in isomorphic-git: the owner may force-push, and the browser runs no Git. |
| [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) | "sync settles with the same merge": sync settles with `settle` and the merge driver. |
| [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) | root `epicenter.json` for CLI `check`: `check` takes a contract; `query` still reads it. |
| [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) | "Epicenter registers no plain-Git merge driver": `merge=epicenter` runs `epicenter merge-driver`. |
| [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) | browser synchronization and "purging committed bytes requires a new repository": the owner may rewrite `main`. |
| [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) | web origins exchanging commits, the browser's Git transport, and `check` with `epicenter.json`: the web never syncs, and `check` takes a contract. |
| [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) | CLI `check` requiring root `epicenter.json`: `check` takes a contract. |
| [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) | the browser's unsent-edit map and publication bookkeeping: a browser holds only its own files and capture sidecars. |
| [ADR-0620](0620-history-in-a-repository-only-grows.md) | "forced or not": the owner may replace `main`, kept at `refs/epicenter/replaced/<time>`; everyone else only moves it forward. |
| [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) | "binary files come later": every non-note file is Git LFS with bytes in R2. |
| [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) | the browser's sync states and recovery: a web app reports only files not uploaded yet. |
| [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) | "browser hosted sync obtains consent": the web reaches a repository through `openRemote`. |
| [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) | principles 1, 2, 5, 6, 7 and 9: the contract, the web never syncs, the merge rules above, and LFS. |
| [ADR-0632](0632-a-lens-belongs-to-its-reader.md) | "CLI check and query require the root epicenter.json": `check` takes a contract. |
| [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) | browser synchronization: the web uploads new files and never syncs. |

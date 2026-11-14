# 0700. Apps share data through a file contract recorded in Git

- **Status:** Superseded
- **Date:** 2026-10-31
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Supersedes:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (one merge where the change wins and no conflict marker is written), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (a Git clone per web origin), [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) (browser sync), and [ADR-0545](0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md) (the hosts' incoming-update engine). It also supersedes the Folder engine's records that [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) superseded before it was rejected, at their Folder and page-editing decisions: [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md), [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md), [ADR-0575](0575-a-control-binds-one-part-of-a-row-fields-are-patched-and-the-body-is-opened.md), [ADR-0630](0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md), [ADR-0654](0654-visible-folder-queries-refresh-without-native-watchers.md), [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md), [ADR-0662](0662-one-path-edit-exposes-text-and-structured-changes-through-one-interface.md), [ADR-0664](0664-folder-close-drains-admitted-work-through-one-owner.md), [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md), [ADR-0669](0669-folder-actions-track-lifetime-without-reserving-paths.md), [ADR-0688](0688-one-folder-owned-text-document-per-path.md).
- **Amends:** the 25 records in [Records this changes](#records-this-changes), each at the scope named there.
- **Amended by:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) at an app's data being a layout of files: an app whose contract declares the document store keeps a document instead, and the Variants table gains document apps; [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) at decision 35 and at `epicenter init --contract`: a folder holds an `AGENTS.md` note naming its contract URL, and `init` records no contract in Git configuration; [ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md) at "every file that is not a `.md` note and not a hidden path is Git LFS": files with a binary extension are LFS, every other file merges as text, and the server refuses a text file over a size cap; [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) at `epicenter init` registering a folder for sync: no folder is registered: the engine scans the library root, a folder elsewhere is a link inside it, and nothing is listed in the global Git configuration; [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at `epicenter init` recording `epicenter.root` and at `--enclosing-ok`: a folder is its own repository at its derived path, and `epicenter.synced` records consent; [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) at "the `.gitattributes` block `epicenter init` commits" and "A folder `epicenter init` has not registered has no history": `init` commits nothing, and a folder has no history until its first sync; [ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md) at "nothing moves between stores" and at moving files between stores being only an explicit action: items a browser extension holds in its own storage move into the app's folder when the engine answers.
- **Amended by:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "Notes merge by one set of rules, wherever a merge runs" and `settle` in the translator: the server never merges a write.
- **Amended by:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at the client's `create`, `update` and `delete`, `over`, and the refusals `NotFound`, `Occupied` and `Conflict`: one write, `set`, takes no version and fails only as `Invalid` or `Unavailable`.
- **Amended by:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at its merge table and `settle`: a body merges by Git's line merge, and front matter by key.
- **Amended by:** [ADR-0796](0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md) at a tool writing house style (schema keys first, sorted, block YAML): it writes only the fields it changes, each value as JSON.
- **Unbuilt:** per-repository grants and the consent page choosing a repository (`openRemote` reaches `<account>/<contract name>` until then); `@epicenter/secrets`; the notify Durable Object that broadcasts "main moved" per repository.
- **Not yet live:** R2 LFS in production. `apps/api/wrangler.jsonc` binds the `epicenter-lfs` bucket, but the presigning key pair has not reached a deployed `api` version, and no LFS upload and download has run against production. Both wait for this branch to merge and for authorization to deploy (see [Revisions](#revisions)).
- **Revised:** 2026-10-31 for decisions 77 to 98 (see [Revisions](#revisions)).
- **Amended:** 2026-11-01 at window Close ([Records this changes](#records-this-changes), ADR-0663's row): a desktop window no longer waits for the writes its page has out, and Quit quits. A window closes at once; `guardLeave` keeps only the browser's "Leave site?" while a write is out, since an online write can take a while to land. The wait guarded only a write out in the instant of closing, at the cost of a close protocol in Rust and TypeScript (`subscribe_close`, `unsubscribe_close`, `destroy_bound_window`, a native "Close anyway?" question, and a custom macOS Quit that closed the primary window), so it failed [ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)'s test for every protection. A recording in progress is still finished when its window is destroyed or the app exits, and a cut-off one is completed by recovery at the next start. This also withdraws the wait [ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)'s 2026-10-20 amendment put on window close, and Quit from what [ADR-0701](0701-apps-run-as-separate-programs.md)'s 2026-10-31 revision says `epicenter-standalone` shares.
- **Amended:** 2026-11-01 at remote setup: `epicenter connect <dir> <repository>` wraps `git remote add origin` for an initialized folder, so the desktop can offer the same explicit action. Plain Git remains valid. This replaces ADR-0558's rejected-command rationale after `sync --to` was removed; `sync` still owns every commit and transfer.

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

**An app has up to three variants, each with one store for its life, and
nothing moves between stores.** An app builds only the variants it needs:

- **Desktop:** the folder, through `openDevice` from `/tauri`. Only Epicenter
  (`epicenter sync`) syncs it.
- **Local web:** this browser's files, through `openDevice` from `/browser`,
  for good. It never syncs and never uploads, and nothing moves it into a
  repository. Signing in with Epicenter is optional and grants capabilities
  only (hosted transcription and AI), never storage.
- **Online web:** the repository, through `openRemote` under a signed-in
  layout that sets it. It works online only and keeps nothing in the browser;
  each create and edit is a commit.

A page opens one store and keeps it; a link to another variant loads a new
page. Sign-in grants capabilities, never storage.

| App | Variants |
| --- | --- |
| Whispering | local web, desktop |
| Capture, Honeycrisp, Todos, Vocab | online web, desktop |
| Messages | local (Beeper Desktop listens only on the person's computer) |
| Recorder demo | local web, online web |

UI components take the client they show, and only a variant's root chooses
the store (the `#platform/root` seam), so adding a variant is one root and a
build, not a change to data code. Each desktop variant is a program of its
own ([ADR-0701](0701-apps-run-as-separate-programs.md)).

Every device opener is async and returns a `Result` whose error is an
`OpenDeviceError` (`Missing`, `NotGranted`, `Refused`, `Unreadable`, or
`StorageUnavailable`), on every platform:

| Opener | Entry | Where | A version is |
| --- | --- | --- | --- |
| `openDevice(contract)` | `@epicenter/folder/browser` | the origin's OPFS, through one Worker, a Web Lock per path | sha256 of the bytes |
| `openDevice(contract, { path })` | `@epicenter/folder/node` (Bun) | a directory | sha256 of the bytes |
| `openDevice(contract, { path, create? })` | `@epicenter/folder/tauri` | the root at the absolute path `path`: the directory the shell bound to the window, or a folder Tauri's file-system scope allows | sha256 of the bytes |
| `openRemote(contract, { account })` | `@epicenter/folder/remote` | `<git audience>/~/<contract name>.git`, every request through `account.fetch` | the Git blob id on `main` |

**A recording is written into the variant's store as it records.**
`startRecording({ device, path })` and `recoverRecordings({ device, under })`
are the same calls from `@epicenter/recorder/tauri`, where the shell writes
a WAV from the first sample and encodes it to Opus in WebM at `<path>.webm`
in the data folder when it stops ([ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)), and from
`@epicenter/recorder/browser`, which appends each MediaRecorder piece (about
a second) to `<path>.m4a` or `.webm` in this browser's files. The app's
`#platform` seam imports one. A quit, a crash, or a closed tab keeps the
audio up to the cut, and `recoverRecordings` repairs a file the cut left
short. An online variant holds the audio in the page until Stop.

**A local web variant reopens offline.** Whispering and Messages register
the shared `cacheSite` service worker (`@epicenter/vite-config/offline`),
which caches the built page and its static files and passes data and other
origins through, and link a web manifest so the page can be installed.
Whispering's desktop build registers no service worker.

This supersedes, in the file-contract design, decision 11 (the web keeps
files in the browser or works online, as one app), decision 12 (files made
offline or signed out upload once signed in), decisions 66 and 67 (a cache of
uploaded audio, and uploads going to whoever signs in next) and the uploading
in decision 76 (two views of one app, with the device's files moving into the
repository). The uploader, the outbox and its sidecars, the cache, the quiet
period and capture adoption are deleted. Moving files between stores can
return later as an explicit action a person takes, not a background rule.

**One browser sign-in covers both audiences.** `account.fetch` carries the Git
token to `openRemote` and the API token to everything else, so an online web
app that also calls the API (Vocab) names both `resources` in
`createBrowserOAuth`. The client sends one redirect for both, with
`offline_access`, exchanges the code for the API, and refreshes once for Git,
then drops the refresh token: none is kept at rest. `Account.fetch` picks the
token of the longest matching resource, origin then path, because local and
self-hosted deployments serve Git at `/git` under the API's origin. A failed
token request fails the sign-in and revokes what was issued. The server keeps a
web client's grant bound to its session (`offlineDetach` skips web clients),
so signing out ends it, and refuses any token naming more than one audience.

**The server translates writes and receives pushes; it holds no data of its
own.** Both live in `mountGitHost` (`packages/server/src/routes/git.ts`):

- The translator, `POST <repo>.git/epicenter/writes` (`routes/files.ts`), reads
  `main`, settles each file, builds one commit per request, and moves `main`
  by compare-and-swap, retrying up to 12 times. It keeps no record of a
  request (no capture refs, no hidden refs), so clone and fetch pass through
  in whichever protocol the client asks for.
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
repository's first commit; `REPOSITORY_IGNORE` (the CLI's `.gitignore` block)
keeps `.DS_Store` and `.epicenter/` out, and sync leaves `.epicenter/` out
itself whatever `.gitignore` says. On Cloudflare, Git lives in Artifacts and LFS objects in R2
(`createR2LfsStore`): clients upload through presigned URLs that sign
`content-length`, `if-none-match: *` and `x-amz-checksum-sha256`, and an object
is admitted after one `head()` matches its size and sha256. On Bun, both stores
are on disk.

The production `api` Worker binds the `epicenter-lfs` bucket as `LFS_BUCKET`,
with `LFS_BUCKET_NAME`, in `apps/api/wrangler.jsonc`. The key pair that
presigns transfers, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, is an
optional Worker secret pair (`LFS_SECRETS` in `apps/api/worker/lfs-store.ts`):
a version deployed without it answers hosted Git with 503 rather than
accepting a push it cannot store. The deployment order, in
`apps/api/README.md` (Deploying R2 LFS), is: merge to `main` and let CI
deploy the version with the binding; put the key pair from Infisical
(`prod`, `/api`) on that deployed version; never roll back to or redeploy a
saved version that carries the revoked credentials; then, only once
deployment is authorized, push a file through Git LFS to a production
repository and fetch it back.

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
epicenter connect <dir> <repository>       add origin to an initialized folder
epicenter clone <ns>/<name> [<dir>]       git clone, then init
epicenter sync [<dir>] [--watch]          commit, fetch, merge, git lfs push, push
epicenter status [<dir>]
epicenter forget [<dir>]
epicenter check <contract> [<dir>]        contract as a URL or a file path
epicenter format <contract> [<dir>]
epicenter merge-driver %O %A %B %P        hidden; Git runs it
```

`sync` exits 0 when synced, 1 to run again, and 2 when stopped for a person or
an agent. A folder links to a repository with `epicenter connect` or plain
`git remote add origin <url>`; the first push creates the repository.

**Desktop Git features may assume an agent; the web assumes nothing.** A
person who reached Git has an agent that fixes its own conflicts, locks, and
rejected pushes, so `sync` stops with exit 2 and leaves Git's state for it. The
web offers only what needs no repair: the online variant creates, edits and
deletes while online, with `Conflict` answered in the app.

**Deleted:** `epicenter generate` and `generate-declaration.ts`;
`epicenter history`, `save-version`, and `sync --to`; the native history engine
(`history`, `native-backend`, `native-checkpoint`, `merge`, and `sync` in
`packages/folder/src/git/`, which keeps only the `git` runner and the browser
storage's object reader); browser sync
(`browser/sync.ts`, `browser/git/transfer*`, `browser/git/publication.ts`) and
the `isomorphic-git` dependency of `@epicenter/folder`; `publishFile`.
Because no data is at rest (decision 72), so is every reader of an older
shape: `epicenter query` and `schema import|export` over a root
`epicenter.json`; the hosted Git host without `objects` that answered as
before the receiver; the browser engine's sync checkpoints
(`remoteBase`, `pendingCommit`, `acknowledge`); the old content-only `merge`
and its `diff` dependency; grants and tokens without a `generation`; Capture's `draft`
files; and `bookmarks.json` cleanup.

## Consequences

- A desktop clone needs `git` and `git-lfs`. A clone without the driver or the
  LFS filters is refused by `sync` and, for raw bytes, by the receiver.
- A web write measured p50 2.3 s and p95 3.2 s on Artifacts, almost all of it
  waiting on Artifacts. A push into a flat folder of 5,000 files took 9.9 s;
  partitioning a layout is an app's option.
- Artifacts caps a repository at 1 GB of Git data; LFS bytes in R2 do not
  count. R2 bytes of deleted files are not collected yet.
- A front matter value that loses a race is visible only in history.
- A version means sha256 on a device and a Git blob id on a remote. The
  server's reply carries blob ids; a binary's is the blob of the LFS pointer
  naming its sha256.
- A local web variant's files exist only in that browser, which may evict
  them; nothing backs them up. A person who wants a repository uses the
  online or desktop variant.
- A repository grant exposes every data folder in that repository.
- The production `api` Worker answers hosted Git with 503 until the R2 key
  pair reaches its deployed version (`apps/api/README.md`); then every push
  goes through the receiver.
- A recording a closed tab cut off is kept in the browser up to the cut, so
  a local web variant needs storage the site may write: a private window
  cannot record.
- Every app is on a contract. `openFolder` and its IndexedDB engine remain
  only for the Epicenter app's own folder editor and AI connections, and the
  editor still reads a root `epicenter.json` for table views; both go when
  those move.

## Considered alternatives

- **A Git clone per web origin** (ADR-0623, ADR-0628): every origin was a
  separate copy to sync, and binary files had no way in.
- **A live sync engine with a browser replica** (`claude/repository-v2`): a
  second record beside Git that stock tools and agents cannot read.
- **A conflict block for front matter:** a note must always parse.
- **The server formatting by contract:** the client formats before sending, so
  the server needs no contract and keeps the incoming key order.
- **Server-held capture receipts** (built, then removed): a write carried a
  capture id, the server moved `refs/epicenter/captures/<id>` with `main` and
  answered a resend with the first landing, or 409 when the bytes differed.
  It took capture refs that grew without end, request fingerprints, refs
  hidden from clients by forcing protocol v0 on Artifacts, and an ancestry
  walk capped at 500 commits, to spare one conflict block in a rare case.

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
| [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) | the browser row's "no `offline_access`" and the resource check's "this resource's audience": a browser asks for `offline_access` only to mint one access token per audience in one sign-in and keeps no refresh token, and a token must name exactly one audience. |
| [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) | "sync settles with the same merge": sync settles with `settle` and the merge driver. Local writes: a client's write is conditional on the version it read, and another writer's change since is a `Conflict`, a different field carried over. |
| [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) | root `epicenter.json` for CLI `check` and `query`: `check` takes a contract, and `query` is deleted. |
| [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) | "Epicenter registers no plain-Git merge driver": `merge=epicenter` runs `epicenter merge-driver`. |
| [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) | browser synchronization and "purging committed bytes requires a new repository": the owner may rewrite `main`. |
| [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) | web origins exchanging commits, the browser's Git transport, and `check` with `epicenter.json`: the web never syncs, and `check` takes a contract. |
| [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) | CLI `check` requiring root `epicenter.json`: `check` takes a contract. |
| [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) | the browser's unsent-edit map and publication bookkeeping: a browser holds only a local variant's own files. |
| [ADR-0620](0620-history-in-a-repository-only-grows.md) | "forced or not": the owner may replace `main`, kept at `refs/epicenter/replaced/<time>`; everyone else only moves it forward. |
| [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) | "binary files come later": every non-note file is Git LFS with bytes in R2. |
| [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) | the browser's sync states and recovery: a web app reports none; the online variant is online or offline. |
| [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) | "browser hosted sync obtains consent": the web reaches a repository through `openRemote`. |
| [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) | principles 1, 2, 5, 6, 7 and 9: the contract, the web never syncs, the merge rules above, and LFS. |
| [ADR-0632](0632-a-lens-belongs-to-its-reader.md) | "CLI check and query require the root epicenter.json": `check` takes a contract. |
| [ADR-0663](0663-one-native-question-before-a-window-or-epicenter-leaves.md) | window Close, which ADR-0689 had amended before it was rejected: a window waits for the writes its page has out (`guardLeave`) and asks nothing; closing again while it waits asks whether to close anyway. (ADR-0701 deleted its application Quit alert.) |
| [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) | browser synchronization: the web never syncs; a local variant's files stay in the browser. |

## Revisions

### 2026-10-31: decisions 77 to 98

- **Three variants, one store each (decisions 77 to 79).** An app builds
  only the variants it needs, each with one store for its life, and
  nothing moves between stores; this replaces one web app that kept files
  in the browser and uploaded them once signed in (decisions 11, 12, 66, 67
  and 76). The uploader, the outbox, the cache of uploaded audio, the quiet
  period and capture adoption were deleted. Every app except Messages and the recorder demo now has a
  desktop variant: Whispering's replaced the build Epicenter used to host,
  and Capture, Honeycrisp and Vocab gained one.
- **Openers return a `Result` (decisions 90 and 94).** `openDevice` became
  async with `OpenDeviceError` on every platform, so a startup screen can
  say what failed and offer what fixes it instead of catching a throw.
- **A recording is written as it records, on every build (decision 84).**
  The browser had held a recording in the page until Stop, so a closed tab
  lost it; it now appends pieces into the store the way the desktop writes
  its WAV, which is what superseded ADR-0543 designed for the desktop.
- **A local web variant reopens offline (decision 85).** Its data never
  needs the network, so neither should its page. A service worker and a
  manifest are all it takes; this is not ADR-0691's hosted-site reopening,
  which ADR-0701 superseded.
- **R2 LFS (decisions 73, 85 and 98).** A new bucket, `epicenter-lfs`, never
  the existing `epicenter-blobs`; the binding lives in `wrangler.jsonc`
  because a dashboard binding is overwritten on the next deploy. A binding
  in configuration is not completion: undeployed `api` versions still carry
  revoked credentials, so the key pair goes onto the version CI deploys
  after the merge, and the feature is done only when an LFS upload and
  download pass against production. Nothing deploys before this branch
  merges to `main`.
- **The desktop programs** (two roots, Tauri's grants, startup and recovery,
  settings notes, the sign-in crate) are recorded in
  [ADR-0701](0701-apps-run-as-separate-programs.md).

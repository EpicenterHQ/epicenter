# 0489. Account identity selects local folders and cloud transfers are explicit

- **Status:** Proposed
- **Date:** 2026-10-02
- **Revised:** 2026-10-05: applications offer explicit Sync with clean history combination and save-before-adoption; editor state may reset after incoming file changes.
- **Implemented:** automatic commits stay local in the TypeScript history and shared Rust owner; TypeScript openers keep local `main` independent of the remote branch and refuse an unexpected browser `HEAD`; Whispering startup uses settings defaults without creating `kv.json`; the Local CLI acquires the native sibling ownership lock.
- **Unbuilt:** account-folder startup, origin-based account opening, staged first downloads, captured-account transport credentials, managed Sync with unrelated-history combination and conflict resolution, and save/adoption/refresh coordination.

## Context

Whispering currently opens a Local folder at `~/Epicenter/local/so.epicenter.whispering`, or the directory `WHISPERING_DATA_ROOT` names. It has no account startup. The folder engine initializes Git if absent. Settings defaults stay in memory until an explicit settings save, so launching Whispering alone creates no source file or commit.

An earlier `commitOnEdit` policy pushed after automatic commits. The revised engine records local history without implicit network work ([ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md)). Native `RootLock` excludes a second owning process, but the Bun opener does not acquire it. Browser OPFS directories and Web Lock names derive from a captured channel, owner, and folder ID ([ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md)); applications do not select account scopes yet.

## Decision

**Folder content transfers are explicit.** Sign-in and listing may retrieve metadata; neither downloads nor uploads folder content. Automatic local commits may remain enabled, but a configured remote never enables automatic pushing. No device enrollment, attachment registry, background retry service, or second synchronization baseline is introduced.

**Applications offer an explicit Sync action.** Once a person has connected the folder to a remote, Sync saves current input, records portable authored changes, fetches that remote's current history, fast-forwards or merges it, and pushes the resulting history. A folder's first commit combines with an unrelated remote root on its own; a folder with a history of its own combines with one only when the person agrees, once ([ADR-0532](0532-a-browser-folder-is-its-id-written-lazily-and-its-remote-is-its-git-configuration.md)). Preserve both histories as parents of the merge commit; never force-push to replace one.

Distinct item IDs make independent creation unlikely to collide. Shared filenames, settings, and edits to an existing item can still conflict. A clean Git merge can also retain duplicate items or produce invalid application data; do not present text-merge success as semantic validation. Conflicts preserve both versions and require a supported resolution view before upload continues for that folder. Other folders can still sync.

```text
Sync
  -> pause new edits and finish saving input
  -> commit portable authored changes
  -> fetch the verified paired remote
  -> fast-forward or merge, including unrelated roots
       -> conflict: retain both versions and show resolution
       -> clean: push the resulting history
  -> refresh views affected by incoming file changes
```

If saving or recording fails, stop before incoming adoption and keep the current editor available. Resume editing after the operation settles, including a reported failure. A rejected push because another device advanced the remote leaves the local history intact and reports that another sync is needed; no background retry loop is introduced. Report saved, recorded, and uploaded outcomes separately. When incoming files changed but the push failed, refresh those files and report the failed upload rather than leaving the editor on stale content.

**Reload is an allowed refresh boundary.** An upload without incoming file changes does not require a reload. If the open item changed, reload its editor; changes elsewhere can refresh the list. A folder or whole-app reload is an acceptable initial implementation after incoming changes when selective refresh is not available. Cursor position, selection, and undo history need not survive. Saved content must survive. Pause edits during save and adoption so reloading cannot discard newly entered input. A native UI reload keeps its existing folder owner; changes to captured account, root, or remote still require the supported owner close/reopen flow.

**Account locations follow ADR-0461.**

```text
~/Epicenter/local/<folderId>/
~/Epicenter/accounts/<account-key>/<folderId>/
```

The account key derives from the exact authority and principal. Independent native applications and the CLI compute the same path from their own sessions. Tokens stay in private session storage, with native credentials in the operating system's credential store. Account identity selects local storage; an origin is optional. Selecting an account folder may create it offline from the cached identity and start saving immediately. This does not establish whether that folder already exists in the cloud. With no current listing, report an unlinked folder and unknown cloud presence.

A browser folder has no account scope ([ADR-0532](0532-a-browser-folder-is-its-id-written-lazily-and-its-remote-is-its-git-configuration.md)): it is the directory its ID names, its remote is its own `remote.origin.url`, set by Connect, and its Git transport reaches GitHub through the connector as the signed-in account, by the repository's canonical clone URL. No pairing is involved.

A moved Epicenter root is selected explicitly in each app or with CLI `--root`. No shared daemon, location registry, or root discovery file is required. Arbitrary clones outside the managed layout remain explicit paths, not automatically registered account folders.

**Origin is the checkout's repository destination.** A normal clone stores the GitHub URL selected through [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) in `remote.origin.url`. The server pairing independently retains the GitHub repository ID for discovery and authorization. GitHub URLs are not immutable lifetime identities. Account credentials come from the session, never from that URL. Discovery compares the configured origin with the account listing and reports differences. It never changes origin, adopts an unrelated directory, or treats matching names and URLs as permission to publish. Explicit raw Git remote changes remain deliberate user operations.

Native account-folder openers read the configured origin; they never replace it with the listing's current URL. Rust offers opt-in `use_repository_origin`; Whispering leaves it off. The Bun and browser openers read the configured origin too; only `folder.sync.connect` sets it. Both TypeScript openers keep local `main` independent of the transfer destination branch. An existing browser repository with `HEAD` on another branch refuses commits and incoming adoption; opening never silently creates a replacement history. Account setup must preserve configured origin; that wiring remains unbuilt. Remotes are captured at opening. The native registry retains owners and their locks after page detachment and releases them only at shutdown. Changing the selected account, root, or captured remote uses the guarded close handshake, process exit, and whole-shell relaunch. A page reload does not replace the owner. Bun and browser handles can instead close and reopen. Use Git commands to edit Git configuration, never hand-edit its files while the owner is active.

**Download is an explicit alternative to creating local data.** A person restoring an existing cloud folder can get it before editing; applications do not require this before account-local opening.

1. Resolve the folder's paired GitHub repository ID and current URL through authenticated discovery. Verify access before issuing repository-scoped credentials. If discovery is unavailable, report unknown and create nothing.
2. Refuse an existing destination. Report its presence and origin without overwriting or retargeting it.
3. Fetch the repository into a dot-prefixed staging directory on the same filesystem and establish local `HEAD` on `main` explicitly. A repository with no `main` is permitted only as an empty repository; initialize local `main` and set origin without manufacturing a commit. Do not use `clone --branch main` for an unborn branch or rely on the client's default branch. Require completed checkout without unrequested content conversions and the native folder layout check; do not load executable folder configuration or require an application schema to download it.
4. Install only if the destination remains absent, holding the cooperative reservation lock and using no-clobber publication. Never merge staging contents into an existing folder.
5. On failure, report retained staging work separately; leave no partial destination that looks ready.

For get, the folder opener runs after installation. Explicit cloud creation instead allocates an empty repository and reports its URL; it need not download or replace an existing account-local folder. Origin can then be configured through explicit Git operations. Discovery never attaches it automatically.

Reserve a setup destination with the existing sibling `RootLock`: create and canonicalize the account parent, validate the folder ID, and lock the child path before staging and installation. Lock acquisition does not require the child directory to exist. No-clobber installation still protects against external filesystem writers; ordinary rename is not assumed to provide it on every platform. Listing ignores dot-prefixed staging and non-folder-ID names.

**An existing account folder connects in place.** A person who recorded before cloud setup keeps the same directory, `.git`, local history, and private device settings. Discover the canonical cloud repository URL, explicitly configure origin, then fetch. Connecting changes the destination; it does not download a replacement working directory or reconcile histories. No separate connect state or content-import workflow is stored.

The destination's actual state determines the next operation:

| Local destination | Explicit incoming operation |
| --- | --- |
| Absent | Staged get and no-clobber installation. |
| Exists, with no commits or source files | Configure origin, fetch, then guarded adoption into the existing folder. |
| Exists, with local files or history | Preserve outstanding files and use Git to reconcile in place. |

The engine initializes Git at opening and commits only when sync checkpoints or a person saves a version ([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)), so saved files are not necessarily committed. Inspect outstanding changes before reconciliation. Stage authored files deliberately: ordinary Git staging does not inherit the engine's exclusions for generated `index.sqlite3` and operating-system scratch files.

The current native reconciliation path uses explicit Git while the shell is fully closed, using the cooperative folder lock. Fetch records incoming history before any working-file adoption. Choose the merge policy from the observed ancestry; independently started histories require explicit permission to join unrelated histories. A nonempty cloud repository does not become an empty one because the local directory was created offline. An empty cloud repository has no incoming head to merge. In this passthrough workflow, push remains a separate explicit action.

Git preserves committed history, not every saved working file. An unrelated-history merge can conflict in `kv.json`, and a successful merge can replace ignored local files. A Git 2.50.1 probe reproduced ignored-file replacement both with and without `--no-overwrite-ignore`. That flag does not establish the engine's collision-refusal guarantee. The proposed managed Sync action must check incoming paths against local ignored and untracked files before adoption, including file/directory collisions, and provide a supported conflict path. It must not force ignored content into history or upload it automatically. Current app controls retain clean fast-forward adoption; in the browser, Todos also offers the folder's single-merge-base `mergeIncoming()`.

After native reconciliation, inspect the resolved files and their audio references before reopening and requesting publication. Git's successful text merge does not establish application validity. Standalone app controls currently have the shared engine's save, commit, fetch, push, and fast-forward mechanisms. The managed Sync policy above requires further implementation for divergent and unrelated histories and conflict resolution. Native Git reconciliation currently requires a Git tool outside that app. Browser reconciliation remains an implementation gate.

**The CLI cooperates with native folder ownership.** Every `epicenter git` invocation acquires `RootLock`, including reads. This prevents a wrapped checkout or merge from racing the app's file publication and automatic commits without requiring a Git mutation classifier. It refuses while an application owns the folder; the person can close that app or use its controls. The lock lasts until Git exits, including time in pagers, editors, and hooks, so an app opened during that interval also reports Busy. Setup uses the same sibling lock. No daemon brokers a live app's ownership. Raw Git takes its own locks and remains outside this coordination promise.

**Keep Git behavior distinct from application behavior.** The current engine's built-in incoming adoption is an explicit clean fast-forward, plus a browser merge of histories with one merge base, both recoverable under [ADR-0474](0474-incoming-git-adoption-retains-a-recoverable-plan.md). The CLI's Git passthrough may explicitly merge, rebase, or restore with ordinary Git semantics. It makes no automatic conflict-resolution or cross-file schema-validity promise. Wrapped operations coordinate with the app owner; arbitrary raw Git commands do not.

The existing controls are `folder.git.commit()`, `push()`, `commitAndPush()`, `fetch()`, `pullFastForward()`, the browser's `mergeIncoming()`, and `recoverIncoming()`. Fetch observes incoming history; fast-forward and merge apply that observation without fetching again. The app's Sync action composes operations and owns the policy above; it does not imply an existing generic `folder.git.sync()` or `pull()` API. A configured destination alone does not reconcile histories. Dirty files, divergent commits, and unrelated roots can currently prevent incoming adoption. Native reconciliation uses explicit Git with the app closed. The browser merge refuses unrelated roots and returns conflicts without writing; a supported path for those cases is still needed before the proposed managed Sync can ship.

**Local stays Local.** Account discovery never uploads or relocates a Local folder. A person may explicitly copy selected current files into a new account folder, preserving the Local original and excluding its history and private credentials. No dedicated publish orchestration is required by this decision.

## Implementation gates

Prove the managed Sync journey on both native files and browser OPFS: finish saving before adoption, combine clean unrelated roots, retain conflict versions, protect ignored and untracked paths, and refresh changed views even after an upload failure. Demonstrate no reload for an upload-only operation and an allowed editor or app reload when incoming files change. Editor cursor and undo preservation are not acceptance requirements. The transport proof can precede these controls, but fast-forward-only success does not establish this journey.

Keep account startup and hosted transfers conditional on end-to-end evidence. First preserve local history when attaching an explicit destination, then exercise push, fetch, and fast-forward against GitHub. GitHub App connection, private creation, folder pairing, credentials, repository-ID checks, and audio history costs still need implementation and measurement. First-party Git hosting remains alternative evidence, not the initial remote implementation. A browser also needs a supported way to reconcile divergent or unrelated histories before multi-device editing ships. Do not add an unused account-address helper or transport option ahead of those consumers.

Before shipping account opening, prove that configuring origin enables explicit app transfers after the supported reopen. Whispering currently leaves `use_repository_origin` off, so relaunch alone is insufficient. A transfer captures the selected account and trusted destination before releasing credentials. Exercise existing directories with unborn history and partial incoming adoption; a failed setup must not be presented as complete or silently committed as a new local root.

Exercise session expiry and logout before reopening a selected account folder. They must not silently select Local or another account and make existing files appear absent. Authentication controls transfer permission; an explicit folder selection controls which local files the app opens. The account key identifies the selected directory without proving that its current session can transfer. The device-private selection owner remains to be implemented; this does not add an active-account pointer to the CLI.

Exercise fetch from repository A, close, configure origin for B, and reopen before incoming adoption. Changing origin retains `refs/remotes/origin/main`; opening-time capture does not prove that this cached commit came from the new destination. Before hosted adoption ships, either require a successful fresh fetch for the captured account and destination or explicitly describe adoption of cached Git refs in the app. Do not present the cached ref as a verified observation of the current cloud repository. This requires no second persistent catalog.

Credential tests must include repository URL rewrites and credential helpers. Supplying a canonical URL as Git argv does not bypass [Git URL rewrites](https://git-scm.com/docs/git-config#Documentation/git-config.txt-urlltbasegtinsteadOf). The invocation credential channel must authorize the actual request destination and keep the token out of repository helpers, hooks, arguments, and logs. Retain opening-time remote capture for the closed-app configuration flow; operation-time capture earns a change only when a supported live configuration action removes the need to reopen.

Whispering stores its transcription key and microphone preference under `.git`. Git transfers exclude them, but a recursive directory copy carries them. Moving that file outside the portable directory requires a migration and concurrency owner: two shells using different roots can run together, so a shared JSON file with an in-process queue and fixed `.next` filename is insufficient. Keep this as a prerequisite for claiming portable folders exclude credentials.

The real Git regression also exposes an isomorphic-git 1.38.5 limitation: after the first push to a non-default branch, an explicit fetch fails if the server advertises no resolvable `HEAD`. Local history remains intact. The cloud contract uses `main`; do not claim support for this alternate-branch bootstrap state or rewrite the server default branch to hide the failure.

## Consequences

- An unpushed commit stays on its device. Matching origin is setup information, not a claim that data is backed up or synchronized.
- An offline-created folder whose name already exists in the cloud can have independent history. Get refuses its existing directory. Linking requires explicit origin configuration followed by history reconciliation. Setup and fetch leave working files in place; explicit Git reconciliation retains ordinary Git risks for uncommitted and ignored files.
- Missing settings use current app or environment defaults until saved. A later launch can show different defaults without changing a file. Lazy defaults remove artificial first-launch roots, not histories created by real edits.
- Directory scans and Git configuration replace local installation and attachment databases. Git refs replace custom transfer baselines.
- A stale origin remains usable for local work. Managed authorization must refuse a replacement repository ID even when its URL matches; raw Git has no such identity check. Offline, current cloud existence and origin agreement are unknown.
- Copying or restoring a folder is ordinary file handling. Restoring old bytes over a live working copy can look like edits; no identity mechanism detects every restore.
- Standalone apps need no Epicenter CLI or desktop service. They share transport and setup code while owning their own sessions and user controls.
- Several apps may use one dataset sequentially; the native owner lock gives a concurrent opener Busy. Account switching settles or explicitly discards the old runtime's unsaved work before opening another scope.
- Locking every passthrough invocation means wrapped `status` and `log` also refuse while an app owns the folder. Raw Git remains available with its own concurrency guarantees.
- After same-name recreation, move the old directory aside before get downloads the replacement. Existing bytes are retained; a deliberate history import remains a Git task.

## Considered alternatives

- **Automatic upload and a private enrollment registry.** They reduce forgotten pushes but add admission, restored-copy, cancellation, and retry policy. Explicit transfers remove that family of work.
- **Require download before every first account opening.** It avoids an independent initial history on a pristine device but makes cloud availability a local editing prerequisite. Local editing takes priority; explicit reconciliation owns the cost.
- **Store a second local destination registry beside origin.** It duplicates the checkout's Git configuration. The server-side folder pairing has a different purpose: discovering a selected GitHub repository ID and authorizing access from another device.
- **Lock only mutating Git commands.** It permits wrapped reads while an app is open, but requires classifying commands, aliases, flags, and hooks. Locking every invocation is the smaller contract.
- **A shared root preference or access daemon.** A preference avoids repeated selection after moving the root; a daemon could broker live access. Neither is needed for the default derived paths.

- **Clone cloud history elsewhere and import existing account files.** It adds content-copy, directory replacement, and recovery policy while discarding or separately reconstructing local history. Existing account folders reconcile through Git in place; staged cloning remains for absent destinations.

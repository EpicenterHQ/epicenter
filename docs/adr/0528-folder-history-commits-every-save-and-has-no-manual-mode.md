# 0528. Folder history commits every save and has no manual mode

- **Status:** Proposed
- **Date:** 2026-10-11
- **Amends:** [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md), withdrawing "Its enablement remains `commitOnEdit`", "Explicit commit and push controls remain available when automatic history is disabled", and "Staged manual authoring requires automatic whole-folder checkpoints to be disabled". Save independence, best-effort automatic commits, local-only automatic history, and the status rules remain.
- **Amends:** [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md), withdrawing `browser.commitOnEdit`, `git.commitOnEdit`, the shell-supplied commit policy, the snapshot's `commitOnEdit` policy, and "The native Todos CLI exercises manual history". The handle's members and its shared status snapshot remain.

## Context

A folder's history had two modes, chosen when it opened. `commitOnEdit`
(default `true`) made every complete save ask for an automatic commit. With
`commitOnEdit: false` nothing asked, and history was authored by hand:
`git.stage(paths)` and `git.commitStaged(message)` in `@epicenter/folder`,
`git add` and `git commit -m` in the folder terminal, and `stage` and
`commit_staged` in the desktop owner. Automatic mode refused staged authoring
as `GitError.AutomaticHistory`.

No application shipped manual mode. Git lab (`apps/git`) opened its working
copies with it, the native Todos CLI (`apps/todos/scripts/native.ts`) did, and
test support across Capture, Honeycrisp, Todos, Vocab, and the folder suite
did. Every one of them already offered Sync (ADR-0514) or explicit
commit-and-push as the way history moves.

## Decision

**Every complete save asks for an automatic commit, and no option turns it
off.** The folder package's Git, in the origin private file system and in the
desktop Rust owner, has one history mode. These are removed:

```txt
@epicenter/folder
  BrowserFolderOptions.commitOnEdit, FolderGitOptions.commitOnEdit
  GitSnapshot.commitOnEdit
  FolderGit.stage, FolderGit.commitStaged, StagedCommit
  FolderGit.diff({ staged, paths })        now diff(paths): unstaged changes only
  GitBackend.stage, GitBackend.commitIndex
  GitError.InvalidMessage, NothingToCommit, AutomaticHistory,
           BranchMoved, IncomingPending   (staged authoring was their only source)
  messageProblem
  terminal: git add, git commit -m, git diff --cached
tauri-plugin-epicenter-folder              PROTOCOL 9 -> 10
  FolderConfig.commit_on_edit, GitSnapshot.commit_on_edit
  commands stage, commit_staged; diff's staged argument
  FolderOwner::stage, FolderOwner::commit_staged
  Git::stage, Git::commit_index, IndexCommit, StagedCommit
  GitError::InvalidMessage, NothingToCommit, AutomaticHistory,
            BranchMoved, IncomingPending
  message_problem
```

The terminal refuses `git add` and `git commit` like any other unsupported
command, and its help lists `git status`, `git diff [paths]`,
`git log [-n N] [--oneline]`, `git push`, `git fetch`, `git pull --ff-only`,
and `git merge`.

**A whole-folder commit covers the whole folder and resets staged-only
changes.** A desktop or directory folder is a real directory with a real
`.git`, and a person can still use their own Git there. Epicenter's next
commit, automatic or explicit, records every source file and resets every
index entry to the new head, so a force-added ignored file or a deletion
staged only in the index does not survive it. `PullError.StagedChanges` still
refuses an incoming update over an index that differs from the head.

**A folder that has never exchanged with its remote adopts the remote's
history on its first Sync.** `sync.run()` reads the remote-tracking ref before
it fetches; when there is none, its merge passes
`allowUnrelatedHistories: true`. This replaces "a folder whose first commit the
run made", which automatic history never meets: opening publishes
`epicenter.json`, and that save commits before any Sync runs.

**Applications exchange history through Sync.** `commit()`,
`commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, and
`mergeIncoming()` stay on `folder.git`, as ADR-0514 keeps them, and the
terminal keeps the commands listed above.

## Consequences

- Git lab commits each copy's saves and its first Sync adopts the shared
  remote. The Todos CLI's `create` and `complete` save, commit, and push.
- A desktop page built for protocol 9 is refused at attach as `Incompatible`.
- A test that needs uncommitted changes writes them as another program or tab
  would, through the filesystem or a raw boundary, because a save through the
  folder commits.
- Epicenter cannot write a commit with a message a person chose. On a desktop
  folder a person who wants one uses their own Git, and Epicenter's next commit
  takes whatever they staged and did not commit.
- A save whose automatic commit is still waiting when the folder closes stays
  uncommitted, as before.

## Considered alternatives

- **Keep manual mode for Git lab and tests.** Rejected: it kept staging,
  message validation, five Git errors, two desktop commands, and a protocol
  field alive for a demo that already teaches Sync.
- **Keep `git diff --cached` as a read-only view.** Rejected: in the browser
  the index always matches the head after a commit, and on the desktop a
  person who stages has their own Git.
- **Keep the first-commit adoption rule.** Rejected: under automatic history
  the run never makes a folder's first commit, so Git lab's second copy could
  never join the remote.

# Git lab

Git lab is a browser testbed for `@epicenter/folder`.
Each working copy owns its files, index, and local history. Git transfers
changes between copies. Opening two views of one folder would miss that boundary.

Start from the repository root:

```sh
bun dev:git
```

The lab is at `http://127.0.0.1:5190/?copy=a`; open `?copy=b` in another
tab. It has no desktop shell. A desktop page's history runs in the `epicenter`
CLI, which only the Epicenter shell starts
([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).
The development command starts or reuses one loopback smart HTTP backend on
port 5191 (`packages/folder/src/git-demo-server.test-support.ts`). The command that starts that backend owns its lifetime.
The printed temporary root contains the bare remote and seed checkout.
`GIT_LAB_DEMO_ROOT` reopens a marked experiment. Fresh experiments have distinct
remote URLs, so their browser working copies start separately.

Select a file to edit raw text, including Markdown. Autosaves replace the
captured file conditionally. Changes made outside the page arrive through
`folder.onFilesChanged` from other tabs open on the same copy. Each one reads the file
list and status again, and the open file when the change names it. The page
also reads again after each of its own actions. An outside change cannot
discard typed input: an edited buffer keeps the version it started from, and
a save that finds the file changed merges with it by line, and the typed text
wins the lines both changed, with no notice (ADR-0575).
**New file** creates an empty file at a path and opens it. The Git panel below the editor keeps its
output while hidden. Binary files stay visible with an explanation. Text editing is limited to UTF-8 files of at most 2 MiB.

**Sync** brings a working copy and the remote together: it commits what
the copy saved, fetches, merges, and pushes. Edits
to different lines combine on their own. When both copies changed the same
lines, the review shows each version beside a result and replaces the
editor and Git actions until you press **Apply and sync** or **Cancel**;
nothing is written before you choose, and Cancel forgets the review. A copy
with no history of its own adopts the remote's on its first Sync.

Nothing commits on its own. **Save version**, **Fetch**, **Pull**,
**Merge**, and **Push** each do one step by hand. Fetch updates remote
knowledge without updating working files. The changes list separates index
and worktree columns; ahead and behind are relative to the last fetched head.
Pull applies the fetched head only as a fast-forward. Merge merges it when it
fast-forwards or merges cleanly; a conflict writes nothing and points to Sync.
If publication stops partway, the files it wrote show as changes, and the
next Sync records and merges them.

Enter an HTTP(S) remote or leave the URL empty for local history. A copy
with no origin connects to the remote once, when it opens, and keeps it as
`remote.origin.url` in its Git configuration. Browser
transport uses fetch and needs a same-origin endpoint or a server that permits
Git requests through CORS. The development proxy only reaches the disposable
loopback remote. There is no browser credential flow or general CORS proxy.
GitHub support has not been demonstrated. SSH remotes are not accepted by
this app.

```sh
bun run --cwd apps/git test
bun run --cwd apps/git typecheck
bun run --cwd apps/git build
```

Computer use, with the terminal and desktop shell this lab had then (both since
deleted), demonstrated native editor saves reaching terminal reads,
native staging and commits, native pushes reaching the loopback remote,
browser fetch changing ahead/behind without receiving files, and pull refusing
uncommitted changes. Browser interaction also demonstrated clean-editor refresh,
raw Markdown, binary explanations, and hidden-terminal output/command retention.
Browser interaction also demonstrated a clean divergent merge, conflict markers,
unresolved commit refusal, reopening before and after staging, and a resolution
commit with both original parents. The standalone release also demonstrated
conflict repair and reopening before and after staging. Both platforms pushed
their resolution commits through the disposable remote; the receiving editor
changed only after pull. See the [iteration evidence](evidence/iteration.md)
for commit identities and checks.

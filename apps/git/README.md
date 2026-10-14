# Git lab

Git lab is a browser and standalone Tauri testbed for `@epicenter/folder`.
Each working copy owns its files, index, and local history. Git transfers
changes between copies. Opening two views of one folder would miss that boundary.

Start from the repository root:

```sh
bun dev:git
bun dev:git:desktop
```

The browser is at `http://127.0.0.1:5190/?copy=a`; open `?copy=b` in another
tab. Desktop opens windows A and B. Both development commands start or reuse
one loopback smart HTTP backend on port 5191. The command that starts that
backend owns its lifetime. Keep it running while the other platform uses it.
The printed temporary root contains the bare remote and seed checkout.
`GIT_LAB_DEMO_ROOT` reopens a marked experiment. Fresh experiments have distinct
remote URLs, so their browser working copies start separately.

Select a file to edit raw text, including Markdown. Autosaves replace the
captured file conditionally. Nothing watches the files: the page reads them
again when its window gains focus and after each of its own actions. An
outside change cannot discard typed input: a failed save offers explicit
replacement or discard. **New file** creates an
empty file at a path and opens it. The Git panel below the editor keeps its
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
In the browser, if publication stops partway, the page shows the pending
update and offers explicit recovery. The desktop build records no pending
update; its next Sync reconciles.

Enter an HTTP(S) remote or leave the URL empty for local history. A copy
with no origin connects to the remote once, when it opens, and keeps it as
`remote.origin.url` in its Git configuration. Browser
transport uses fetch and needs a same-origin endpoint or a server that permits
Git requests through CORS. The development proxy only reaches the disposable
loopback remote. There is no browser credential flow or general CORS proxy.
GitHub support has not been demonstrated. Desktop uses installed Git with
interactive credential prompts disabled; configured Git credential helpers
can apply. SSH remotes are not accepted by this app.

The standalone bundle runs the same page and the same TypeScript folder
engine over a directory the shell grants. Rust chooses directories under app
data (or `GIT_LAB_ROOT` during development), creates them, and registers each
copy for the one window that opens it first; that window keeps it until the
app quits, and the other window is refused. Commits take `user.name` and
`user.email` from Git configuration, global included; "Working copy A" or
"B" applies only where none is set. The capability grants folder commands,
unscoped fs reading commands that the folder plugin scopes to a copy's
directory when it grants it, and the app's copy commands to windows A and B.
The page reads through Tauri's fs plugin; the shell makes every write and
runs Git. Quitting waits briefly for writes and Git commands already
running; text typed in the last moment before an autosave can be lost. CSP
allows IPC; remote Git transport runs in installed Git and needs no browser
network grant.

```sh
bun run --cwd apps/git test
bun run --cwd apps/git typecheck
bun run --cwd apps/git build
bun run --cwd apps/git build:desktop-ui
bun run --cwd apps/git build:desktop
```

Computer use, with the terminal this lab had then, demonstrated native editor saves reaching terminal reads,
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

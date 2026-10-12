# Git lab

Git lab is a browser and standalone Tauri testbed for `@epicenter/folder`.
Each working copy owns its files, index, and local history, and every save
commits. Sync transfers changes between copies. Opening two views of one folder would miss that boundary.

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
captured file conditionally. An outside change cannot discard typed input:
a failed save offers explicit replacement or discard. Terminal writes refresh
the tree and clean editor. The terminal below the editor keeps its session,
output, and typed command while hidden. Binary files stay visible with an
explanation. Text editing is limited to UTF-8 files of at most 2 MiB.

**Sync** brings a working copy and the remote together: it commits anything
not yet committed, fetches, merges, and pushes (`@epicenter/svelte/sync`). Edits
to different lines combine on their own. When both copies changed the same
lines, the review shows each version beside a result and replaces the
editor and terminal until you press **Apply and sync** or **Cancel**;
nothing is written before you choose, and Cancel forgets the review. A copy
that has not yet fetched from or pushed to the remote adopts the remote's
history on its first Sync. The desktop build's folder owner does not sync
yet; there the terminal's Merge button stays.

Every save, from the editor or the terminal, commits on its own. There is no
`git add` or `git commit`. The terminal runs `git status`, `git diff`,
`git log`, `git fetch`, `git merge`, `git pull --ff-only`, and `git push`.
Fetch updates remote knowledge without updating working files. Ahead and
behind are relative to the last fetched head. `git merge` merges the last fetched
head when it fast-forwards or merges cleanly; a conflict writes nothing and
points to Sync. If publication stops partway, the page shows the pending
update and offers explicit recovery.

Enter an HTTP(S) remote or leave the URL empty for local history. Browser
transport uses fetch and needs a same-origin endpoint or a server that permits
Git requests through CORS. The development proxy only reaches the disposable
loopback remote. There is no browser credential flow or general CORS proxy.
GitHub support has not been demonstrated. Desktop uses installed Git with
interactive credential prompts disabled; configured Git credential helpers
can apply. The terminal is the folder's supported shell, not an unrestricted
system shell. SSH remotes are not accepted by this app.

The standalone bundle embeds the same page through the Tauri folder adapter.
Rust chooses directories under app data (or `GIT_LAB_ROOT` during development)
and creates them before registration. Its capability grants folder commands
and the app's copy commands to windows A and B. CSP allows IPC; remote Git
transport runs in Rust and needs no browser network grant.

```sh
bun run --cwd apps/git test
bun run --cwd apps/git typecheck
bun run --cwd apps/git build
bun run --cwd apps/git build:desktop-ui
bun run --cwd apps/git build:desktop
```

The demonstrations below predate automatic history; the staging and terminal
commits they mention are gone. Computer use has demonstrated native editor
saves reaching terminal reads,
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

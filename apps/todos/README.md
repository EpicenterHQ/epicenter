# Todos

A file-first todo list. Each todo is a plain Markdown file, `todos/<stem>.md`,
with `title` and `done` in frontmatter and notes in the body. The browser keeps
the folder and its Git history in IndexedDB. A file browser shows every file in
the folder, and a terminal edits the same files and runs real Git commands
against that history. A loopback Git server lets the browser push to a bare
repository that an ordinary native checkout pulls from and pushes to.

This is a development demo of `@epicenter/app/files`, not a released app. It
uses no hosted API, account, or secrets.

## Run it

From the repository root:

```sh
bun dev:todos
```

This starts the Git backend on `127.0.0.1:5187` and the UI on
`http://127.0.0.1:5186`, and prints the session: the bare repository, the
native checkout, and the remote URL. The UI reaches the backend same-origin
through the Vite proxy at `/git/todos.git`. `bun dev:todos:ui` starts the UI
alone; pushes and fetches then fail and say so, while saves and local commits
keep working. Set `TODOS_DEMO_ROOT` to a directory printed by an earlier run to
reopen it.

## Controls

The todo list and its editor fill the window. The header holds the rest:

| Control | What it does |
| --- | --- |
| Files button (Ctrl+B) | Shows or hides the file browser: a pane on wide screens, a drawer on narrow ones. |
| Status button | Shows the most important current fact, shortened on narrow screens. Open it for saved files, uncommitted changes, the last commit, the remote, and the last pull as separate lines with the times they were observed, plus "Check again" and "Fetch". When the last remote check saw commits on both sides, it says the histories diverged; the browser only fast-forwards, so local commits are kept until the histories are resolved. |
| Pull | Fetches, then applies the remote only as a clean fast-forward. A refusal is shown as "Pull stopped" with the reason, and in the status details. |
| Commit and push | Commits the saved files and pushes. Unsaved typing is not included. |
| Terminal button (Ctrl+\`) | Shows or hides the terminal. It is hidden at first; its output, history, typed command, and working directory stay when it is hidden. |

On narrow screens the list, the editor, and the terminal take turns; the
editor has a Back button, and the file browser opens as a drawer.

Unsaved input lives only in this open page. Switching files keeps each
editor's draft, but drafts are not stored anywhere else. While any editor has
unsaved typing, a save in progress, a failed save, or a conflict, reloading or
closing the tab asks first with the browser's leave warning. Leaving anyway
discards that input; files already saved stay as saved.

## What to try

1. Add a todo. The file saves immediately; a commit follows in the background,
   then a push. The status details report saved files, uncommitted changes,
   the last commit, and the remote separately. They say "Changes need
   checking" or "Check failed" instead of claiming a clean folder when the last
   observation is out of date or failed; focus and "Check again" check again.
2. Edit the title, notes, or raw source. Typing stays in the editor until its
   save; a save that races another writer stops and offers "Discard mine and
   load saved" or "Save mine over it".
3. Open the file browser. Folders expand and collapse; a todo file opens its
   todo editor, and any other text file opens in a plain editor with the same
   save and conflict rules. Raw file saves request no commit, so the change
   shows as uncommitted until Commit and push. A file that is not UTF-8 text,
   or is over 1 MB, shows its type and size and is never saved as text.
   Right-click a row, or use its "…" button, for Open, Rename, Copy path, and
   Delete; on a folder, New file and New folder. With a row focused, arrow
   keys move and expand, F2 renames, Delete asks to delete, and Shift+F10
   opens the menu.
   - Renaming or deleting a todo file goes through the table, so its
     same-stem attachment moves or goes with it. Any other file is renamed or
     deleted only if it still has the version you saw.
   - Rename and delete refuse while the file's editor has input that cannot be
     saved, and the input stays in the editor.
   - Delete always asks first, naming what it removes. Only empty folders can
     be deleted from the browser. Renaming does not update references to the
     old name in other files.
4. In the terminal: `ls todos`, `cat todos/<stem>.md`, `echo '...' > note.md`,
   `git status`, `git add note.md`, `git commit -m "..."`, `git log --oneline`,
   `git diff`, `git push`. Shell writes are saved files but request no commit.
   Files matched by `.gitignore` stay out of status and automatic commits; a
   tracked file stays tracked. A later automatic commit or Commit and push
   resets staged-only changes to the committed state.
5. In the native checkout printed at startup:

   ```sh
   git pull --ff-only
   $EDITOR todos/<stem>.md
   git commit -am "Edit natively" && git push
   ```

   Then press **Pull** in the browser. Pull applies only a clean fast-forward;
   uncommitted changes, divergent history, or an incoming file that would
   overwrite an ignored or untracked one are reported and nothing is written.
6. `bun apps/todos/scripts/native.ts <checkout> status` prints the native
   folder's JSON status through `openNativeFolder`. `create "<title>"`,
   `complete <stem>`, `commit-and-push`, `fetch`, and `pull` are also available.

Write a file with invalid frontmatter (for example `printf -- '---\ntitle: *missing\n---\n' > todos/bad.md`)
to see a row marked "Needs repair"; its title and done controls are disabled
and structured edits are refused, and you fix it in the Source tab.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineStore` declaration. |
| `src/lib/folder.ts` | Opens the browser folder from the mounted page. |
| `src/lib/editor.svelte.ts` | One draft's buffer, baseline, save queue, and conflict choice, shared by todo and raw text editors. |
| `src/lib/files.ts` | File browser rows, and which files open as editable text. |
| `src/lib/todos.svelte.ts` | Todo and folder listings, path selection, retained editors, and file actions. |
| `src/lib/terminal.svelte.ts` | The terminal session that outlives the terminal pane. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, file browser, list, editors, and terminal. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `scripts/dev.ts` | Starts the backend and Vite together. |
| `scripts/native.ts` | JSON CLI over the native checkout. |

Checks: `bun run --cwd apps/todos typecheck`, `bun run --cwd apps/todos test`,
and `bun run --cwd apps/todos build`.

# File-authoritative field notebook

This is a disposable end-to-end demo. Markdown, JSON, and image bytes in the selected account folder are the current data. The typed views and both terminals read those files. Git records commits and transports them between devices; the browser keeps its Git objects and refs in private storage, apart from the current files.

## Run the acceptance path

From the repository root, with Bun, Git, Git LFS, and Playwright Chromium installed:

```sh
bun install
bun run --cwd examples/file-notebook acceptance
```

The command runs focused boundary tests and a Chromium walkthrough. It creates a disposable native folder, local Git HTTP remote, and LFS store, then removes them. The walkthrough exercises a browser edit, a just-bash edit, a native Bash edit, Git/LFS in both directions, and recovery from a ZIP after the native backend stops. It also checks conflict refusals and raw byte preservation. See [EVIDENCE.md](EVIDENCE.md) for the latest observed result.

To explore the workbench, start these commands from the repository root in separate terminals:

```sh
bun dev:file-notebook:desktop
bun dev:file-notebook
```

Open `http://127.0.0.1:5173` for browser current files and `http://127.0.0.1:4317` for native current files. The desktop command starts a local Git/LFS fixture and uses `/private/tmp/epicenter-file-notebook-demo/desktop/Epicenter/accounts/demo` by default. You can pass a different native account folder to the example's `desktop` script. The browser stores its remote URL and account folder label in device-private `localStorage` keys `fileNotebookRemote` and `fileNotebookAccount`. The default label is `demo`; the acceptance path starts with `trip-archive` and renames it to `trip-renamed`. Use the same label on both devices. After changing the label in the browser and pushing its commit, restart the desktop workbench with the renamed folder path before continuing desktop edits.

Create the JPEG photo row, then the note. The note's Markdown body links to the photo with a relative path. Change the note or weather setting in the typed view, read it in the terminal, and edit the note with `sed -i`. Commit and Push in the browser, Pull on desktop, edit with native Bash, Commit and Push there, then Pull in the browser. Download ZIP to capture the complete current account files. Open it in an empty browser context to inspect the files without the Git fixture. Browser Commit uploads JPEG bytes to the fixture's LFS store, so it requires a connection even before Push.

## Boundaries

Two inert `defineStore` definitions describe notes and file rows. `openFileStore(definition, files)` borrows the selected account files through an `AccountFiles` interface and interprets their source; it does not open an independent Yjs document, SQLite database, or blob store. In the current production app, `openLocal` and `openPersonal` own Yjs-backed app state. This example is a separate demonstration of a file-authoritative opener, not a migration or compatibility path.

Browser current files live in one IndexedDB file store. The shell delegates reads and conditional writes to that store. Desktop current files are ordinary files under the selected folder. A row is one Markdown file with an optional same-stem attachment, for example `f1~photo.md` and `f1~photo.jpg`. The typed view reports malformed source and ambiguous attachments while leaving raw files available. Typed edits change the source range for the declared field and preserve unrelated bytes. ZIP export includes materialized image bytes, not LFS pointers.

The demo refuses Pull when current files have uncommitted edits, when local and remote commits diverge, or when an incoming commit deletes a browser file. Pull succeeds without changing files when the local commit is ahead of the remote. It does not merge or resolve deletions. The browser shell exposes a small set of commands and does not support `rm` or `mv`. Native app writes compare the file revision before replacement and serialize cooperating app writers, but an arbitrary Bash write in the final check-to-rename window can still be lost. The browser LFS client uses the fixture's standard batch endpoint. The Git/LFS server is a disposable loopback fixture, not an authenticated remote.

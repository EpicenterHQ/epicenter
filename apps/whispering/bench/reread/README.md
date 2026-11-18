# Folder re-read timing

How long Whispering takes to read its whole folder again, which it does on
every window focus and after every write (`src/lib/folder-query.ts`). Each
part is timed on its own over a generated folder. Nothing here runs in
`bun run test` or `cargo test`; each script runs only when called.

## Make a folder

```sh
bun bench/reread/fixture.ts <dir> 15000
```

`fixture-files.ts` describes it: each recording's note beside an empty
`.webm`, and about one transcript of 0.5 to 6 KB per recording (54 MB of
notes at 15,000). The same count makes the same files.

For a cold disk cache without root, put the folders on a disk image and
detach and attach it before a run:

```sh
hdiutil create -size 2g -fs APFS -volname rereadfx -type SPARSE fx.sparseimage
hdiutil attach fx.sparseimage -nobrowse
hdiutil detach /Volumes/rereadfx && hdiutil attach fx.sparseimage -nobrowse
```

A disk image's cold reads are slower than the internal disk's, so they
are an upper bound.

## Time it

| Part | Command |
| --- | --- |
| The shell: `list` and `read_many` over the disk | `cargo run --release -p whispering-files --example reread_timing -- <dir> [runs]` |
| The shell and IPC in a real webview | `cd bench/reread/ipc-harness && cargo run --release -- <dir>...` |
| The page: JSON, unpacking, parsing and checking notes, `folder.read()`, structural sharing, the library and table | `bun bench/reread/page.ts <dir> [runs]` |
| The browser: OPFS | `bench/reread/opfs.ts`, from the dev page's console (see its header) |

`page.ts` runs the app's own `openFolder(tauriFiles(...))` over a stand-in
`invoke` that answers from memory, so it times only the page's work. Bun
runs JavaScriptCore, the engine of the desktop app's webview.

The IPC harness is its own Cargo workspace, outside the repository's. It
builds against the same `whispering-files` and the Tauri version the app
uses; point `CARGO_TARGET_DIR` at an existing target directory to reuse
compiled dependencies.

# OPFS acceptance

## Current page

From the repository root:

```sh
bun packages/folder/evidence/opfs/serve.ts            # the page on 127.0.0.1:5181, or PORT
bun packages/folder/evidence/opfs/serve.ts --build    # compile check only
```

The page opens folders through the production browser opener in its own
origin's OPFS, under `Epicenter Dev/local/opfs-evidence-*`, and removes only
those directories when the run finishes. Keep the same host and port: the
origin is the storage. No application origin is touched.

Besides the file, history, recovery, identity, and closing checks, which
use conditional file and table commands, the page checks row repair against
real OPFS: malformed and schema-invalid text reads as `InvalidRow` with its
exact text, and a `replace` guarded by that read saves the canonical row.

2026-10-11: the three row editor checks (ordered `set` and observation,
repair through the editor, and a removed row's failed save and `reload`)
were retired with the row-API clean break (ADR-0515), which removed the row
editor.

Stream probes use the browser's own OPFS API in a directory of the run's own:

- An open write stream refuses the removal of its file and the recursive
  removal of a directory above it; a sibling file stays, and the write lands.
- A stream for a file removed after its handle was taken: recorded as a note,
  since an engine that does not recreate the file only makes the recheck
  unnecessary.
- With the `getFile()` recheck the replacement makes, that stream is aborted
  and the path stays absent.

Move probes, which a folder's new file relies on (it is written to
`.git/epicenter/scratch` and moved into place where the files lock has just
found nothing, ADR-0576):

- A file moves into an absent name in another directory, whole, and leaves
  its old name.
- A move onto an existing name, and onto one with an open write stream:
  recorded as notes, since storage never moves onto a name that is there.
- A folder's new file appears whole and leaves its scratch directory empty.

2026-10-16, headless through Playwright 1.62 with a persistent context:

- Chromium 151 (macOS arm64): 21 passed, 0 failed. A move onto an existing
  name replaces it without a word; onto a name with an open write stream it
  is refused (`NoModificationAllowedError`) and the stream's bytes land.
- WebKit 26.5: names differing only by case or Unicode form are one name
  (`case.md` meets `Case.md`, so its create is `Exists`); the run then
  stopped at the two-context stage and did not finish, so its move probes
  did not run.
- Firefox: not run; Playwright 1.62's build was not installed.

Run the page in the browser under test before claiming any other result.

2026-10-16, later: the file checks write with `folder.write` and move with
`folder.move` (ADR-0576). A create onto a file is `InvalidPath`, and the
two-context save race is now two writes from one version that both land,
the later merged over the earlier. Not yet run in a browser; the counts
above are from the run before this change.

2026-10-17: a create onto a file is `Occupied`, and the page's create race
expects it; the file checks read with `files.read`, since `files.open` is
gone. Not yet run in a browser.

### Chrome 142 behavior the replacement relies on

The coordinator's probes in Chrome 142 on macOS observed what the stream
probes check: an open write stream refused removing its file and the
recursive removal of an ancestor directory, and left a sibling untouched; a
stream opened for a removed handle and closed without a recheck created the
file again; with a `getFile()` recheck, which was `NotFoundError`, aborting
the stream left the path absent. `src/opfs-store.ts` depends on these.
`src/opfs.test-support.ts` models them, and `src/opfs-store.test.ts` tests the
store against that model; the model shows the protocol, not that any browser
behaves that way. No other engine, and no other Chrome version, is verified.


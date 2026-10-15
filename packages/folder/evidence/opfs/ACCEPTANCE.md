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

These checks have not been run in a browser since they were written. Run the
page in the browser under test before claiming any result.

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


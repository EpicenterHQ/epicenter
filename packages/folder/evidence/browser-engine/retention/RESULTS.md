# Browser repository retention evidence

Recorded on 2026-10-19 with Bun 1.4.3 on macOS arm64. The production engine
ran in Chromium 151.0.7922.34, WebKit 26.5, and Firefox 153.0.

`storage.retention.test.ts` checks that a shared blob remains while either B or
C needs it, an uncertain C and newer E survive, and objects reachable only
through an older commit parent are removed. It also runs collection and a new
publication from two handles in both transaction orders. A missing live tree
aborts collection and leaves unrelated stored objects untouched.

`sync.test.ts` confirms that a pull-only adoption sweeps superseded snapshots
while an idle sync does not sweep. `smoke/local.ts` uses two real pages per browser.
It inserts an unreachable candidate beside a pending commit, unsent edit, and
file shared across commits. Collection removes the candidate while preserving
all three. After another profile reopen it races collection with a saved edit,
confirms the candidate is physically absent from IndexedDB, and reopens again
to read the edit and shared file. `smoke/sync.ts` collects after a native Git
server accepts a push whose reply is lost, then again with newer unsent work.
The same pending commit survives both sweeps and later ancestry recovery.
All three engines passed both browser runs. The sync run also passed native
`git fsck --strict` and confirmed the uncertain commit appears once in server
history.

The checks ran with:

```sh
bun test --isolate packages/folder/src/browser
bun run --cwd packages/folder typecheck
bun packages/folder/smoke/local.ts
bun packages/folder/smoke/sync.ts
```

The package suite passed 137 tests and 527 assertions. These are desktop
browser profiles and graceful reopenings. They do not establish forced-kill,
quota, eviction, phone persistence, or hosted-service behavior. The smoke
fixtures are small; phone memory and collection duration over large object
closures remain release measurements.

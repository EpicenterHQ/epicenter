# Two worlds prototype: results

Throwaway prototype for ADR-0692, 2026-10-27. An in-process stand-in for the
per-repository server object, an in-memory Git, devices and an agent; no
network and no Cloudflare. Browser runs use headless Chromium and WebKit
through Playwright on the owner's Mac.

Run:

```sh
bun test packages/folder/evidence/two-worlds-prototype        # claims 1 to 4
bun packages/folder/evidence/two-worlds-prototype/browsers.mjs  # claim 1 across engines, claim 5
```

## Claims

| Claim | Result |
|---|---|
| 1. Seeding from a commit is deterministic | **Holds.** Byte-identical seeds in Bun, Chromium and WebKit at 5,000 and 50,000 rows (SHA-256 `411a1144b8ab…`, `8c7d10bd237a…`). Two independently seeded docs merge edits without duplicating text. Control: seeding under random client ids drops one device's edit. After seeding, the handshake sends under 20 bytes. |
| 2. The quiet switch loses nothing | **Holds.** Edits are live across devices, checkpointed on the last disconnect, and the Yjs state is deleted when the alarm fires. Both devices reseed on reconnect, fetch no files, carry nothing, and end byte-identical to the server. Reconnecting before the alarm keeps the epoch. |
| 3. An offline carry-over keeps its edits without undoing others' | **Holds.** Different paragraphs: both survive, and a file the offline device never edited keeps the other device's change. The device fetched only the 2 changed files. Same paragraph: both versions kept, theirs then mine. An offline edit beats a delete it never saw. |
| 4. A push merges into live typing; an overlapping push is rejected | **Holds.** A clean push lands as a merge commit while keystrokes are in flight, and both survive in every device and in the next commit. An overlapping push is rejected with the conflicting path, and lands after the agent pulls and merges. |
| 5. Opening and seeding in WebKit | **Acceptable on desktop.** See below. |

## Open and seed times

| Engine | Rows | Seed | Open (read + apply + project) |
|---|---|---|---|
| Bun | 5,000 | 71 ms | n/a |
| Chromium | 5,000 | 82 ms | 40 to 42 ms |
| WebKit | 5,000 | 75 ms | 48 to 55 ms |
| Bun | 50,000 | 443 ms | n/a |
| Chromium | 50,000 | 745 ms | 287 to 324 ms (about 27 + 250 + 24) |
| WebKit | 50,000 | 638 ms | 345 to 382 ms (about 90 + 240 + 41) |

The seed is about the size of the text: 14.7 MB at 5,000 rows and 146.9 MB at
50,000.

## What the prototype found that the ADR should say

- **The push check only sees what has been delivered.** Keystrokes still in
  flight when a push lands merge with it through Yjs. In the same paragraph as
  the agent's change, they interleave by character, and no rejection is
  possible.
- **The first open downloads text, not a document.** A new device fetches
  every file's content once and seeds locally, so it gets about the text's
  size in bytes, not a Yjs state.
- **The same-paragraph carry-over puts the other device's version first, then
  the offline device's.** That ordering is a choice, not a consequence.

## Limits

- Delivery is synchronous and in-process: no reordering, hibernation, storage
  limits, or alarm timing of real Durable Objects.
- A derived seed client id can in principle collide with a random one; not
  handled.
- `lastSynced` is recomputed from the whole document on every delivered
  update, which is fine for a prototype and not for 50,000 rows; a real device
  would track it per path.
- The merge is by line, and a change touching an adjacent line counts as
  overlapping; `merge.ts` would need the same "clean or conflicting" answer.
- Phone hardware and real networks were not measured.

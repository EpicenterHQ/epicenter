# You Keep Yjs for the Callback, Not the Conflict

> Historical article. It predates universal records, record Lenses, and the
> deletion of Markdown materializers from the live data path. Yjs now owns
> bounded record documents; scalar synchronization uses the record protocol.

I almost kept Yjs for the wrong reason. The pitch for CRDTs is always conflict resolution: two devices edit the same field offline, both edits survive, the merge is automatic. But Epicenter is a tool I mostly use alone across my own machines, and two of them almost never write the same row at the same second. If merge were the only reason, I'd be paying for insurance I rarely claim.

The real reason is quieter. Yjs is an in-memory observable document. A write fires a callback, and the callback materializes a markdown file to disk. SQLite has no native way to call you back.

```txt
yjs write  ->  observer fires  ->  materialize <root>/fuji/entry.md
                     ^
              this is the whole product
```

This got sharper once I decided the markdown files would be read-only, a one-way projection of Yjs that you never edit by hand. That deletes the disk-merge story, which was the loudest argument for a CRDT. So I had to ask the honest question: with merge mostly off the table, why not just host the data in SQLite and skip Yjs entirely?

## The Durable Object version is real, not a strawman

You could host each user's data as a per-user SQLite database inside a Cloudflare Durable Object. Give every device a local cache. The app edits against the cache, the cache syncs up to the DO. Offline would even work: queue the writes locally, replay them when you reconnect.

```txt
   ┌──────────┐                       ┌──────────┐
   │ laptop   │ ──┐               ┌── │  phone   │
   │ (cache)  │   │               │   │ (cache)  │
   └──────────┘   ▼               ▼   └──────────┘
              ┌─────────────────────────┐
              │  Durable Object         │
              │  per-user SQLite        │   <- the authority
              └─────────────────────────┘
```

I want to be fair to this. It's a clean design, and a DO is a genuinely nice serialization point: one writer, in order, no merge to reason about. If I dropped offline writes, it would be the simpler choice.

But look at the diagram again. The three databases are not equal. One of them is the authority and the other two are caches that have to phone home. This is the pattern every SQLite sync engine converges on, even the ones that started peer-to-peer (see [Every SQLite Sync Engine Ends Up Server-Authoritative](./every-sqlite-sync-engine-ends-up-server-authoritative.md)). Offline is a feature you bolt on, and the moment two caches drift, you are back to writing merge logic by hand, which is the exact thing you were trying to avoid by picking SQLite.

## Yjs makes all three locations true peers

In the Yjs version there is no authority. My laptop holds a full replica, my phone holds a full replica, and the relay holds one too. They reconcile against each other, and any update applies in any order.

```txt
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ laptop   │ <────> │  relay   │ <────> │  phone   │
   │ (Y.Doc)  │        │ (Y.Doc)  │        │ (Y.Doc)  │
   └──────────┘        └──────────┘        └──────────┘
        full              dumb               full
       replica            pipe              replica
```

Offline support comes for free here, and not as a feature I wrote. There is no server in the write path to be offline from. Each replica is already whole, so "offline" is just "a peer I haven't talked to yet." When the phone reconnects, it exchanges deltas and converges. I never wrote a reconnect-and-replay path, because applying a synced update is the same operation as making a local one.

## The part SQLite can't give you

Here is the thing that actually decides it. A local edit and a remote sync are the same event.

```txt
local action:   invokeAction -> Yjs update -> observer fires -> materialize
remote sync:    relay delta  -> Yjs update -> observer fires -> materialize
                                     ^^^^^^^^^^^^^^^^^^^^^^^^^
                              one event. the materializer never
                              learns which one it was.
```

So the entire wiring, both for my own edits and for a sync coming in from my phone, is one line:

```ts
doc.on('update', () => materialize(workspace));
```

The materializer hangs off that and re-renders the files for whatever changed. It does not care if the change came from `epicenter run entries_update` on this machine or from the relay catching me up after a flight. Same callback, same code path.

SQLite has no `doc.on('update')`. To get the same behavior you build a change feed, and you end up with two code paths: the local write path, and the "a sync update arrived, apply it to the rows, now also fire the materializer" path. You keep them consistent by hand. The DO can emit on its own writes, since it is the choke point, but the moment a second device's write lands you are rebuilding the notify-and-rematerialize half yourself. Yjs collapses both halves into one observable.

That is the real lever. Not "Yjs merges my conflicts." It's "Yjs is in memory, so keeping the files on disk in sync with the data is a callback, not a polling loop or a hand-rolled trigger system I have to keep honest."

And that callback was never really about markdown. It fires once, and I can hang anything off it.

```txt
                      ┌─> <root>/fuji/*.md    (read + grep)
yjs update -> observe ┼─> SQLite mirror       (SQL queries)
                      ├─> FTS5 index          (full-text search)
                      └─> vector embeddings   (semantic search)
```

One observe, many projections. The SQLite mirror is not a tax I pay for picking Yjs; it is one more thing I get from the same callback, and it makes the query surface more expressive, not less. Anyone consuming the data gets real SQL, search, and embeddings, all kept current by the write that already happened. People worry an in-memory CRDT won't scale, but Yjs keeps the document in memory precisely so reads and observation are cheap, and a personal workspace is nowhere near big enough for size to be the constraint. (More on that in [Why Yjs Is Surprisingly Fast](./why-yjs-is-surprisingly-fast.md).)

## Where I'd still reach for the other design

I'm not pretending Yjs is free. The update log grows over time, and you carry history you may not always need. That is the real cost, and it is worth naming. (The SQLite mirror is not on that list anymore, since I just argued it earns its keep as the query layer.)

And merge has not vanished entirely. The rich-text bodies are still a Y.Text, and there concurrent edits to the same document are plausible, not theoretical. Last-write-wins on a text blob would silently drop one of them, so that is the one place I'd keep a CRDT even if everything else were rows.

If I were always online and the phone were just a thin client, I'd probably pick the Durable Object and one SQLite file, and I'd be happy. The reason I don't is not the merge. It's that an observable in-memory document lets me treat "data changed" and "files on disk should change" as the same thought, and treat "I edited" and "a peer synced" as the same event.

## Why this is still right when I'm the one hosting

There is a company version of this argument, and it points the same way. Epicenter sells a hosted option, but the hosted piece is a sync server, something close to a relay, not the owner of your data. Your devices hold the real replicas; the server just passes deltas between them. That is a very different posture from "we hold your database and lend you a copy."

If we literally owned the SQLite, the vision breaks, because replicated SQLite forces one of two bad shapes. Either we hold the writable copy and hand users read-only replicas, so they no longer own their data, or every device runs its own writable SQLite and we bolt a cache-and-reconcile layer onto each one, which is the merge problem again with extra steps and a server wedged in the middle. Neither is something I want to ship to someone who came to Epicenter to own their files.

The peer-and-relay model sidesteps the whole dilemma. Nobody is the authority, so privacy is the default rather than a policy I have to promise. It is also why self-hosting stays clean: running your own wiki or docs is just running your own relay, because the data already lives in full on every device. There is no authoritative database to stand up, replicate, and guard. Size is not the constraint, performance is fine, and the ownership story stays honest whether I run the relay or you do.

Merge is the insurance I rarely claim. The callback is the engine I run every single write. If you're weighing a CRDT against a synced SQLite cache, weigh that part, not the conflict demo. I made the broader version of this call in [Why We Picked Yjs Over SQLite Sync](./why-we-picked-yjs-over-sqlite-sync.md); this article is the piece of it I almost got wrong. The code is in `packages/workspace` if you want to see how thin the materializer actually is once the document does the observing for you.

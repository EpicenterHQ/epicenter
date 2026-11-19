# 0283. A generation's collection is a ledger that allocates, admits, and sweeps

- **Status:** Accepted
- **Date:** 2026-08-28
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at its route table. The small object holding the generation list stays and gains two jobs; `GET /current`, `PUT /current`, and the envelope `POST` body do not survive. Numbering by increment, "a generation object knows its own name from `ctx.id.name`", and the ban on `idFromString` are unchanged and load-bearing.
- **Amends:** ADR-0277 at the address surface, which moves under `/api` and gains explicit non-existence.
- **Amended by:** ADR-0290 at two words in the minting paragraph. An upload is no longer resumable, because a mint is never resumed; and "a visible ledger row a person deletes" survives only as far as ADR-0287 allows, which is that an abandoned number is inert rather than removable. The route table is unchanged.
- **Amended by:** ADR-0293 at mint allocation timing and the data-bearing request.
- **Unbuilt:** all of it.
- **Amended by:** [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) at most of its decision. The tombstone, the sever, the per-generation sweep, the on-wake gate, `410`, and `DELETE` are all withdrawn; the ledger survives as an allocator, a browse list, and a register of addresses whose consumer is account erasure.
- **Amended by:** ADR-0295 at the per-document routes and the address register, which have no subject once a generation is one document.

## Context

A Durable Object has no existence check. `idFromName` plus a request instantiates it lazily with empty storage, `deleteAll` leaves the name re-creatable, and no API enumerates a namespace. Two consequences follow that nothing in the design so far handled.

A device still holding a deleted generation reconnects, sends its state vector, is honestly told the authority has nothing, and pushes its entire local copy back. The deletion silently fails. The same hazard inverted: dialing a generation number that was never allocated creates it, and a client could populate it. And deletion cannot enumerate what to delete, because a generation is many objects and the application document's row list omits every row deleted during normal life.

## Decision

**The collection object at a store's address is a ledger: it allocates generation numbers, admits requests to them, records every document address it admits, and serves the browse list. It is never deleted.**

```txt
  GET    /api/data/v1/<dataId>/generations                    the browse list
  POST   /api/data/v1/<dataId>/generations                    allocate a number
  PUT    /api/data/v1/<dataId>/generations/<n>/<table>/<row>  one row document
  PUT    /api/data/v1/<dataId>/generations/<n>                the application document, last
  GET    /api/data/v1/<dataId>/generations/<n>[/<table>/<row>]  stored bytes
  GET    <any document path>?state-vector                     the peer question, without a socket
  DELETE /api/data/v1/<dataId>/generations/<n>                tombstone, sever, sweep
  WS     <any document path>                                  the three-message protocol
```

- **`/api`, not `/v1`.** The root `/v1` namespace is deliberately promised to foreign OpenAI-compatible clients (`/v1/chat/completions`, `/v1/audio/transcriptions`), and `server-app.ts` mounts the cookie-CSRF gate on `/api/*` only. A mutating store surface outside that prefix would sit outside the one legible rule about where the gate lives.
- **The principal is never in the URL.** It is stamped from the resolved bearer and prefixed onto the Durable Object name, so the URL and the object name are the same string with one segment in front (ADR-0092, ADR-0225). Path segments that become part of a name are constrained in the route pattern rather than checked in the handler, so a bad segment fails to route before any handler sees it.
- **There is no `current` and no promote.** Latest is the highest complete, untombstoned number (ADR-0281).
- **Minting is allocate, fill, and an implicit seal.** `POST` returns a number. The client uploads documents by `PUT`, in parallel and resumably, and the application document last. A generation is complete when its application document exists, because the application document names every row, so a generation without one has no entry point and is unreachable by construction rather than hidden behind a flag. Rows-first is a client convention and is deliberately unenforced; a bad mint is a visible ledger row a person deletes, and a `409` during a mint means abandon it and delete that row.
- **`PUT` is birth and happens once.** A second `PUT` to an existing document is `409`. The socket is how a document is edited afterwards, and `GET` is how it is copied. The three never overlap.
- **The zip never reaches the authority.** A client parses the artifact and uploads documents; the server has no codec and decodes no field.
- **Deletion is tombstone, sever, sweep.** The ledger is tombstoned first, so everything after is recovery and an interrupted delete resumes from an alarm. Live sockets are closed explicitly with an application close code, because a socket opened an hour ago walks straight past a gate that only sits at the door. Then each recorded address is `deleteAll`ed, in bounded batches that reschedule themselves rather than relying on the platform's six retries.
- **A document object asks the ledger once on wake, and that is the gate.** It memoises admission durably; the sweep's `deleteAll` erases the memo, so a post-sweep wake re-asks and is refused. Generation numbers are never reused, so a memo can only go stale by tombstone, and a tombstone is what triggers the sweep that erases it. A per-request gate would add a subrequest to every read forever to close a window this already closes; a thousand-row backfill would pay a thousand of them.
- **`404` and `410` stay distinct.** Never allocated is `404`; tombstoned is `410`, whose body says to re-read the list and does not name a successor. Naming one would reintroduce `supersededBy`: successor as of when, and why would a client trust it? A browser cannot read a failed upgrade's status, so a client that loses a socket classifies the failure with one HTTP `GET` before deciding whether to retry.
- **`?state-vector` is a representation of a document,** not a path segment. The segment after a generation number is a table name, and `state-vector` is a legal one; the reserved-name collision this avoids is one `store.ts` already documents paying for three times.
- **The ledger records every address it admits,** which is what makes a sweep complete. Enumerating the application document's rows would miss every row deleted during the generation's life and every address a buggy client ever dialed.

## Consequences

- One small, single-writer object holds allocation, status, the sweep list, and the browse list. These are one record rather than four, because existence and enumerability are the same fact.
- The ledger is never emptied. Deleting a store's data means tombstoning every generation and keeping the list, at a cost that rounds to zero; emptying it would make every number re-creatable and return the hazard one level up.
- A generation's browse row carries created-at, reason, approximate size, `lastWriteAt`, and `lastConnectedAt`. Size is reported write-behind by each document on fold and on completion, because no single object knows it and computing it at browse time is a fan-out. "Every device has moved" is deliberately not offered: there is no device registry, a laptop in a drawer would block a deletion forever, and quiescence timestamps are the honest substitute.
- The document Durable Object gains one storage key and one wake-time subrequest. That is the whole price of making deletion final.

## Considered alternatives

- **A flag in every document object.** Incoherent: row objects are minted lazily throughout a generation's life, so "no flag yet" cannot mean "refuse", and an object that was never written has no storage to hold a flag in. A Durable Object cannot testify to its own nonexistence.
- **A flag in the generation's root object only.** Works, and splits truth across two objects that a crash between two writes can leave disagreeing, while making the busiest object a dependency of every row fetch.
- **A per-request gate at the Worker.** Correct and redundant with the wake-check, at the cost of one subrequest per request forever.
- **An explicit `seal` verb.** Honest, and unnecessary once the application document is the only entry point. Enforcing completeness would need a manifest declared at allocation, which is the seal returning under another name.

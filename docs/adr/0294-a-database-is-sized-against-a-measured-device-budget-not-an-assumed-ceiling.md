# 0294. A database is sized against a measured device budget, not an assumed ceiling

- **Status:** Accepted
- **Date:** 2026-08-29
- **Relates:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md), ADR-0284, ADR-0277, [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)
- **Unbuilt:** nothing. This records a measurement and the sizing rule that follows from it. It does not change any code, and it does not retire the row-document split.

## Context

Several decisions were priced against a ceiling nobody had measured. The
N-document split, row addresses, the envelope, section-addressed bootstrap, and
the index/record schema tax of ADR-0284 all exist to keep a single Yjs document
from becoming too large to hold on a device. "Too large" was an assumption.

A phone is the binding case: a desktop SPA in a WebView (ADR-0227) has whatever
memory the browser gives that tab, and iOS gives the least and kills rather than
throws. iOS also exposes no memory API at all, in any browser, because every iOS
browser is WebKit. So the size of a document on the device that matters most was
not merely unmeasured; it was not directly measurable.

**Method.** A page served over Tailscale claims memory in fixed blocks, touching
every page so the OS commits it, until the tab is killed. Running that on an
empty tab gives the tab's total budget. Running it again with a document loaded
gives the headroom left. The difference is what the document costs. Every
observation is written to `localStorage` before the block that might kill the
tab, so the kill is the result rather than a lost session. A second instrument
grows one document in place until the tab dies, giving the row ceiling directly
and independently.

**Measured, iPhone 15 Pro, WebKit, device otherwise idle, `@y/y@14.0.0-rc.24`:**

| observation | value |
| --- | --- |
| tab budget, empty | 1,792 MB held; killed claiming 1,856 MB |
| 50,000 rows at 2,600-byte bodies | 544 MB, or 10.9 KB per row |
| 190,000 rows, grown in place | survived |
| 200,000 rows, grown in place | killed during build |
| open, `applyUpdateV2` | ~4.4 ms per 1,000 rows |
| sorted first screen over every row | ~0.8 ms per 1,000 rows |

A body-size sweep in Bun, reading JS heap rather than RSS, separates the fixed
per-row cost from the per-byte cost: about 4.2 KB per row plus 1.4 bytes per
body byte. Calibrating that against the phone's 10.9 KB per row at 2,600-byte
bodies gives the on-device model below. Process RSS overstates this by 2 to 3
times because it counts memory the allocator has freed but not returned; RSS is
the wrong instrument for this question and an earlier estimate of 19 KB per row
was wrong for that reason.

## Decision

**A database is sized against the measured device budget, and its cost is
modeled per row and per byte rather than per row alone.**

The on-device cost of one Yjs document is:

```
bytes ≈ rows × 5.5 KB  +  total body bytes × 1.8
```

The budget is the tab's, not the document's. Reserve for the application:
against a measured 1,792 MB on an idle iPhone 15 Pro, treat **1,400 MB** as the
usable figure once Svelte, the UI, and ProseMirror are resident.

Two consequences follow directly and both are load-bearing:

**A database is a collection, not a vault.** Pages is a database. Calendar is a
database. One database holding everything a person owns is the shape this model
refuses, and it is the only shape it refuses.

**Memory is the only constraint; time is not.** At the memory ceiling a document
still opens in under a second. There is no size at which the application is
alive but slow. Sizing arguments are memory arguments, and a performance
argument that does not reduce to memory should be treated as unsupported.

## Consequences

**The ceiling is roughly 50 times the largest real collection.** At the Epicenter
vault's measured mean page of 3.2 KB, a database holds about 127,000 pages
within 1,400 MB. `~/Code/vault/pages` is 1,501 pages and 4.84 MB, which is about
1% of that.

**Large pages move the limit but do not collapse it.** Because cost is
per-byte-dominated once bodies are large, the ceiling converges on roughly 780 MB
of raw text however it is divided:

| mean page | cost per row | pages within 1,400 MB | as raw Markdown |
| --- | --- | --- | --- |
| 1 KB | 7.3 KB | 196,000 | 196 MB |
| 3.2 KB (measured vault mean) | 11.3 KB | 127,000 | 409 MB |
| 10 KB | 23.5 KB | 61,000 | 610 MB |
| 25 KB | 50.5 KB | 28,000 | 700 MB |
| 50 KB | 95.5 KB | 15,000 | 750 MB |

**The forcing argument for the row-document split is withdrawn.** ADR-0284 split
the application document into an index and per-row documents to keep residency
bounded. At the measured ceiling that pressure does not exist at any real vault
size. This record does not retire the split, because the split may still be
justified on grounds this measurement does not address, such as sync granularity
or per-row authority. It removes the memory justification specifically, and any
future defense of the split has to stand on something else.

**Engine choice is no longer a memory question.** A 1.3× to 2× difference between
CRDT engines is irrelevant against 50× headroom. Loro's measured advantages are
cold open and lazy containers, and neither is a constraint here. Anything that
would trade `@y/prosemirror` and Yjs 14's attribution work for residency is
trading a real asset for a number that does not bind.

**These numbers are preliminary and the method is not authoritative.** They are
one device, one browser engine, one synthetic corpus of uniform 2,600-byte
bodies, and a subtraction whose resolution is the block size. The two smallest
document probes disagreed with each other by 2× because their signal was only a
few blocks wide; only the 50,000-row probe has enough signal to trust. The
budget itself is not a constant: 1,792 MB is what an idle phone gave an
otherwise-empty tab, and a phone under pressure will give less. An iPhone 15 Pro
is a high-end device and a floor measured on older hardware would be lower. Treat
the model as an order-of-magnitude instrument that settles a question which was
previously off by two orders of magnitude, not as a spec. Re-measure before any
decision that depends on the difference between 100,000 and 130,000 rows.

**One path remains unmeasured.** Every number here starts from bytes already in
memory or fetched over the wire. Opening from OPFS, which is the real launch
sequence, has not been timed on a phone.

## Considered alternatives

**Infer the ceiling from process RSS on a development machine.** Rejected: RSS
overstated the cost by 2 to 3 times and would have set a ceiling 3 times too
low. The gap is allocator retention, which is a property of the process, not the
document.

**Treat tab death during a growth run as the measurement.** Rejected as the
primary instrument: survival is not a quantity, so it cannot answer what a
document costs, only whether one particular size fit. It is retained as an
independent check, and it agreed with the subtraction method.

**State the ceiling in rows alone.** Rejected: a row with no body still costs
about 4.2 KB, and a 50 KB row costs twenty times that. A rows-only ceiling is
wrong by an order of magnitude at both ends of the range.

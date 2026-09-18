# 0343. A preview is an output, and the side that showed it applies it

- **Status:** Proposed
- **Date:** 2026-09-03
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at three bounded places. Its three verbs become one factory, `createWorkingCopy`, whose `pull` and `push` each run the whole sequence and take an approval through a callback; `diff` is not a verb any more. Its manifest keeps `kv`'s values rather than `kvHash`, and the sentence explaining why a hash was right there is withdrawn as wrong rather than as outgrown. Its host gains one promise it did not make, that a write lands only on the folder it was prepared against. The cycle, the completeness rule, absence as a fact, and the whole-or-nothing rule are unchanged.
- **Relates:** [ADR-0338](0338-the-folder-wins-and-a-push-is-one-approval.md) (one approval, which this gives a shape), [ADR-0341](0341-the-folder-moves-only-when-a-person-says-so-in-both-directions.md) (both directions ask, which this stops asking each surface to implement), [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (the concurrent writer this exists to survive)
- **Built:** all of it, in `packages/app/src/data/artifact/checkout.ts`, `apps/epicenter/src/checkout.ts`, and `apps/honeycrisp`.

## Context

ADR-0341 gave both verbs the same shape: show a list, take one approval, apply
only what was approved. It did not say who holds the list in between, and the
answer fell out as "the caller". `diff` returned a `FolderState`, a component
kept it in `$state` across an `await` on a person, handed it back to `pull` or
`push`, and read a `FolderChanged` refusal to learn the folder had moved and it
should ask again.

Every surface offering the button therefore implemented the guard. Honeycrisp
implemented it twice, once per direction, in two components that had to agree
about what "it moved" means and what to show next. Two copies of a guard is two
chances to approve one thing and apply another, and the failure is silent: what
lands is a list nobody read.

The guard also could not be complete from that side. A plan item names a value
on both sides, so a value edited twice makes a different plan; a body and a new
file carry only a path, so the same paragraph edited twice made a plan that
compared equal. Both items grew a `fileHash` to close that, which is a hash per
item to answer a question about the folder.

And no comparison made in the application closes the window at all. The library
read the folder, compared, and wrote; between the read and the write an agent
writing a file loses it. ADR-0330 says an agent uses the surfaces a person
uses, so that writer is not a hazard the folder tolerates, it is the workflow
the folder exists for.

## Decision

**A preview is an output, and never an input.** `pull` and `push` hand one to a
`confirm` callback and take back `true` or `false`. Nothing a caller keeps can
stand in for the reading the verb is holding, because there is nothing to hand
back.

```ts
const folder = createWorkingCopy(data);
await folder.pull({ confirm: (preview, { stale }) => showPullDialog(preview, stale) });
await folder.push({ confirm: (preview, { stale }) => showPushDialog(preview, stale) });
```

**The loop belongs to the verb.** Read, ask, read again, and apply only if
nothing moved; a folder that moved is the next turn with `stale: true`, not a
refusal a surface has to translate. So `FolderChanged` is gone, and a person
reads the list that is true now instead of an apology.

**There is no `diff`.** A `confirm` that records its preview and returns `false`
is one, and it cannot drift from what the verbs compare, because it is what
they compare.

**The host states which folder it handed back, and a write names the folder it
was prepared against.** A read answers with an `ETag` over the bytes it
produced, a write must carry it back as `If-Match`, and the host compares in
the same slot it sweeps and writes in. That is the only comparison that closes
the window, because only the side holding the filesystem can make it.

Three things follow, and none is a mechanism:

- **A folder has one identity, so no item needs its own.** `fileHash` is gone
  from both items that carried one. One fact about the folder answers "is this
  still what was read" for every file, including the ones the plan never named.
- **The host keeps no lock on disk.** A `mkdir` lock bought exclusion against
  nobody: the desktop host is the one process that owns `~/Epicenter`, it never
  guarded the agent writing files directly, and a crash leaked it permanently,
  leaving the folder refusing every request with no repair a person could find.
  A promise chain in the host does the same work, dies with the process, and
  covers reads too, so a read never catches a folder half-replaced.
- **`If-Match` is required, not optional.** A checkout with no reading behind it
  is a write nobody approved, and refusing it at the wire makes that impossible
  rather than merely unlikely.

**A build with no filesystem has no working copy.** `#platform/folder` hands
over `createWorkingCopy` or `undefined`, rather than a boolean beside a verb
every build could still call.

## Consequences

A surface writes a dialog and nothing else. Honeycrisp's two components lost the
plan they held, the staleness they tracked, the refusal they translated, and the
partial-application file that bound the verbs to the store.

A verb can now be waiting on a person, which is a state the old shape could not
be in. Two of them over one folder would each apply a list read before the other
one wrote, so the second is refused with `Busy`, per store rather than per
working copy. A `confirm` that never answers holds the folder until it does; a
surface closes its dialog with `false` rather than dropping it.

The loop needs a bound that is not a count. Each turn either costs an approval
or follows a folder that really moved, and a host that refuses the reading it
just handed back is an error rather than another turn. That last one is what
stops a `confirm` answering `true` without asking anybody, which an empty pull
is expected to do.

A host that will not state a folder's identity cannot be written to at all. That
is `HostUnstated`, and it is louder than the alternative: a fallback would make
every write refused, every refusal read as the folder moving, and the verb turn
forever.

## Considered alternatives

**A proposal object with `apply()`.** `pull` returns `{ preview, apply() }` and
the caller decides. It reads well and tests without a fake dialog. It loses
three ways: `apply` can be called twice or an hour later, the stale loop returns
to the caller, which is the duplication being deleted, and the application once
again holds a library value across an await. An async generator and a two-call
protocol are the same shape with different syntax.

**Keeping `diff` as a diagnostic export.** A fourth entry point whose only
honest use is a test, and a second answer to what the folder holds that could
drift from the one the verbs use.

**A lock file with a PID and a timestamp**, so a leaked lock could be reclaimed.
That makes a bad concept recoverable rather than deleting it: it needs a
staleness heuristic, a repair path, and a sentence to a person about a hidden
directory. The exclusion it buys was never needed.

**Rendering the preview in the library**, so a caller ships only dialog chrome.
What the application owns is what a library cannot have: note titles for live,
trashed, and nonconforming rows, and the name a person calls Recently Deleted.
A library renderer prints `notes/9f2c` where a person needs "Standup 3 Sep".
Vocabulary is the application's (ADR-0244). The one safety it would buy, that a
new plan item cannot be forgotten, is bought instead by rendering through a
`switch` that fails to compile.

**Queueing the second verb behind the first's `confirm`** instead of refusing
it. A dialog that opens when the previous one closes asks about a folder nobody
has looked at since.

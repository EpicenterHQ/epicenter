# 0338. The folder wins, and a push is one approval

- **Status:** Proposed
- **Date:** 2026-09-02
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at "What a push refuses", which becomes what a push does: nothing in a folder is refused now except a folder nothing ever wrote. Its cycle, its manifest, absence as a fact, and its whole-or-nothing rule are unchanged. It also withdraws that record's "A person whose manifest is stale resolves it inside the push": a person resolves it in the folder, and the push is one yes or no. [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the body's mechanism, which was a whole-value replace and is now a rewrite of the live node, and at its per-row question, which becomes part of one approval. Its rule that a body reaches a store only when a person asked for it stands, and pushing is the asking.
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) and [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (the lens this rests on), [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md) (the value/node split), [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (who edits and who pushes), [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md) (why a row id is minted and never chosen), [ADR-0299](0299-a-row-is-its-scalars-and-one-content-node.md) (the codec's two verbs, which this adds a third to), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (why a manifest from another generation is no base)
- **Built:** `ContentCodec.rewrite`, in `packages/app/src/data/definition/declaration.ts` and the three codecs that implement it, with `packages/app/evidence/data/rewriting-a-body.test.ts` measuring what it costs. And the rest of it, except the one thing below. `packages/app/src/data/artifact/checkout.ts` validates nothing, deletes the row whose file is gone, reads a removed frontmatter line as `null`, and takes one approval: `PlanAnswers`, `PlanAnswer`, `answersFor`, `answerKey`, the `conflict` kind, `PlannedBlock`, and `BlockReason` are gone, `PushIncomplete` is `PlanStale` and fires only on a plan that stopped being true, and a folder nothing wrote is `FolderUnwritten` rather than one refusal per file. `apps/honeycrisp/src/routes/components/SendFolderEdits.svelte` renders the overview as one block of plain text with two buttons, and `Enter` reaches **Push all**. `NoteList.svelte` shows a note this release cannot read beside the readable ones.
- **Unbuilt:** the overview does not say that a value will make a note unreadable, because the plan carries no field types to predict it with. `kv.json` was unbuilt and is not: a setting is `PlannedSetting`, the manifest records kv's values, `PushableData` carries the kv write, and an unparseable file is kept as `kv-unreadable`. It is a value item without a row rather than "a row with no body under the key `kv`", which is what this record guessed: a `PlannedValue` needs a row id, and inventing one would make every renderer special-case a table name to print a setting. What a kv edit costs is what any value edit costs, because an application reads a setting as `kv.get(key) ?? DEFAULT` and `get` already answers `undefined` for a value it cannot read.

## Context

ADR-0337 shipped the cycle and refused five things, and a push holding any
refusal applied nothing. Two of them happened constantly: an agent writing
`notes/scratch.md`, and anyone editing a paragraph. The only way out of either
was opening Finder and deleting the file.

The first draft of this record fixed that by making every refusal answerable:
each difference became an item a person answered `file` or `store`, and only a
missing file and an unwritten folder still stopped a push. That removed the
wedge and built a second thing in its place, a dialog where a person decides one
change at a time. Two facts killed it.

**The definition is a read lens, and the folder had become a stricter door than
the store's own API.** `update` validates nothing (`packages/app/src/data/store/document.ts`),
conformance runs at read (ADR-0125), and an undeclared field rides through a
write untouched (ADR-0240). `packages/matter-core` already answers a junk
`matter.json` by degrading to the raw view with a diagnostic. Four of the plan's
nine refusals were a validator nobody had asked for, refusing at the folder what
the store accepts through every other door.

**Once nothing is refused, a per-item answer has almost nothing to decide.**
Answering `store` meant "keep what is here, and let the re-render rewrite that
file", which is the repair loop the folder already is: cancel, edit the file,
push again. A person whose agent rewrote the prose of eight notes was asked
eight identical questions, and by the fourth was clicking without reading. The
one case where a button was genuinely cheaper, a body edited here and in the
folder since the pull, is a hand merge either way.

## Decision

**A push applies the folder, whole, after one approval.**

```txt
a value changed              goes in. whatever it says, including null.
the body changed             goes in. the old text is gone.
a file appeared              becomes a note, renamed to its id.
a file disappeared           the note is deleted for good.
a file that cannot be read   rewritten from the store.

nothing wrote this folder    not a plan. pull first.
```

**Nothing is validated on the way in.** A name the table does not declare, a
value that does not fit its field, and a new file missing half its fields are
all written. The row is then one this release cannot read, which is a state the
store already has a word, a surface, and a record for. A folder that refused
them was catching at one door what every other door admits, and the repair is
the same either way: fix the line and push again.

**A removed frontmatter line is `null`, and there is no unset verb.**
`frontmatter.ts` writes `null` for an absent value and for `null` alike, and
`same()` compares them equal, so the file format already decided this. Deleting
a line therefore reads as `null` and applies as an ordinary value edit. On a
nullable field that is the designed no-value; on any other it is a value this
release cannot read, like any other. What a true unset would cost is a
`TableHandle` verb with one caller and a row state the declaration was designed
not to have (ADR-0255: a definition has no optional fields, and absent is not a
type).

**Deleting a file deletes the row.** No table declares a trash field, and none
should: `deletedAt` is Honeycrisp's product concept, and reserving a third key
beside `id` and `content` (ADR-0309) to teach the platform one application's
trash view is the wrong layer. Trashing a note through the folder is setting
`deletedAt` in the frontmatter, which is line one of the table above. So both
gestures exist, and they are different: edit the value to trash it, remove the
file to delete it.

**There are no per-item answers.** A push is one yes or no, and the folder wins.
To change any of it, cancel, edit the file, and push again, which is the loop a
person is already in. What survives from the answerable draft is the comparison
underneath it: `base` from the manifest, `file` from disk, `store` from the
database, per field. It is what the overview prints, not what a dialog asks.

**Every push shows an overview and takes an approval, including a push carrying
one changed value.** There is no threshold and no silent push. `pull` remains
the destructive direction and keeps its own refusal.

**The overview is ranked by what is still reachable afterwards.**

```txt
Gone for good              deleted notes, and text replaced
Changed                    values set and notes created, with the old value shown
Rewritten from your notes  files the push cannot read
```

Not by which region of the file moved. A value is safe because the old one is
printed beside it and can be typed back; prose is not, because `rewrite` clears
the node and the editor's history with it; a deleted note is not, because it
skips the application's own trash, and that line has to say so. Inside a
section it follows the format everybody already reads: a fixed verb column,
sorted by the name the note is known by, one line per change. A note appears
twice when two things happened to it, which is what `git status` does when a
file is staged and modified at once.

**A body comes home as a rewrite of the live node.** `ContentCodec` carries a
third verb beside `encode` and `decode`:

```ts
rewrite: (node: Y.Type, text: string) => Result<void, ContentError>;
```

`decode` mints a node for a row that does not exist yet; `rewrite` makes the
node a row already holds say what a text says, in place. It is the codec's
rather than the store's because only the codec knows what its node's content is
(ADR-0309 keeps the platform from reading inside one): two codecs clear a
sequence and refill it, and a conversation's log lives in its node's attributes,
where a sequence delete would clear nothing.

**Absent is `null`, unreadable is ordinary, and both are the application's to
show.** A push now produces rows this release cannot read, on purpose, from a
text editor. The application has to surface them.

## Consequences

- **A note can be broken from a text editor, and that is the design.** It is
  also why the note list has to show a note this release cannot read before a
  push stops validating. Today `NoteList.svelte` says so only when the list is
  otherwise empty, so one broken note among a hundred is invisible. Turning off
  validation first would ship a folder that makes notes disappear with nothing
  to look at.
- **What deletes:** `PlanAnswers`, `PlanAnswer`, `answerKey`, `answersFor`, the
  `conflict` kind, `PlannedBlock`, `BlockReason`, `field.check` in the plan,
  four of nine discard reasons, and every `file`/`store` string in the dialog.
  `samePlan` stays, for a different reason: it now guards against applying a
  change a person did not read, because an agent may still be working while the
  overview is open. `PushIncomplete` is the one that survives under another
  name: with nothing unanswered and nothing blocked, a stale plan is all it
  reports, so it is `PlanStale`, and the folder nothing wrote is its own
  refusal, `FolderUnwritten`, which `pull` answers with too.
- **`push` gains a delete pass and `PushOutcome` gains `deleted`.** The verb is
  `TableHandle.delete`, which exists.
- **A rewrite is better than a replacement, not safe**, measured in
  `packages/app/evidence/data/rewriting-a-body.test.ts`. The node and every binding
  to it survive. A peer's keystrokes inside a block the rewrite removed do not,
  and two devices rewriting one body concatenate rather than one winning. A
  replacement would have lost one device's whole node and detached every editor
  bound to it, which is why this is the trade rather than a cost-free win.
- **An editor bound to a rewritten note loses its undo history**, because the
  push's origin is not one the undo manager tracks and the stack it kept refers
  to items the rewrite deleted. `Editor.svelte` clears it, which is also right
  for a peer's edit arriving over the socket.
- **The overview is one piece of plain text**, so a person can read it on screen
  and paste it to the agent that made the mess. ADR-0330 gives an agent the
  surfaces a person uses, and this is one; the agent's own review surface stays
  the folder and `.epicenter/manifest.json`, which holds every base value.
- **The file extension stays `.md` for every table of every application**, and
  `layout.ts` says why: the platform owns the file, a codec writes a region
  inside it, and the host that sweeps row-shaped paths holds no definition to
  ask.

## Considered alternatives

- **Every change is an item a person answers `file` or `store`.** This record's
  own first draft, and the reason it exists. It removed ADR-0337's wedge, and
  then charged a click for each of eight identical prose rewrites while
  answering `store` only meant "let the re-render do what it was going to do."
  What replaced it is the same information with one action.
- **The folder validates what it accepts.** Rejected. It made the folder a
  stricter door than `update`, `create`, and every sync path, all of which admit
  a value this release cannot read (ADR-0125, ADR-0240). Validation belongs
  where Matter already puts it: a reader that reports, not a gate that refuses.
- **A `trash` key on `TableDeclaration`, so a deleted file lands there.**
  Rejected. It reserves a third key beside `id` and `content` to encode one
  application's trash view in the platform, and it is unnecessary: setting
  `deletedAt` through the frontmatter already does it.
- **An unset verb on `TableHandle`.** Rejected. `null` is the unset, the file
  format already writes it for an absent value, and a removed attribute is a row
  state ADR-0255 designed away.
- **Ask about a body only when the store's copy moved too.** Rejected, narrowly.
  It is defensible: with nothing typed here since the pull, a rewrite overwrites
  nothing anybody wrote. It loses the case that matters, an edit on a second
  device that has not synced, and prose is the one thing where seeing the list
  before it goes is worth more than the click it saves.
- **Group the overview by note.** Rejected. Everything that happened to one note
  reads together, but the irreversible change and the safe one happened to the
  same note, so the ranking that answers "is anything about to be destroyed"
  disappears. `git status` shows one file in two sections for the same reason.
- **Group the overview by frontmatter and body.** Rejected. It splits by which
  region of the file moved, which is not what a person scanning a plan is
  looking for.
- **Partial push: apply what can be carried and leave the rest.** Rejected, and
  now unreachable: nothing is left behind to be partial about.
- **Derive the file extension from the codec.** Rejected, at greater length in
  `layout.ts`.

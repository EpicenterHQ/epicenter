# 0205. A recording is a row that fills, and a crash finishes it rather than losing it

- **Status:** Superseded
- **Superseded by:** [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) and [ADR-0366](0366-recording-is-an-app-scoped-portable-capability.md), revised 2026-09-17: Stop saves a completed recording as an independent app-local blob, then the application workflow creates a row containing its BlobId reference; unfinished capture is disposable. The row-first, no-cancel, and crash-finishes-it promises below are historical. This does not revive ADR-0184's single global capture slot.
- **Date:** 2026-08-03
- **Supersedes:** [ADR-0184](0184-one-host-recorder-progressively-stages-each-claimable-recording-until-its-owner-stops-or-cancels-it.md). Its one-recorder rule, its single slot and `Busy` refusal, its flat-memory streaming WAV, its refusal of a second audio channel, and its refusal of in-capture `fsync` and periodic header checkpoints are all restated below and unchanged. What is withdrawn is the claimable-recording model: the staging identity, the claim, and the clause "host death loses active capture."
- **Historical amendment before supersession:** [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) at blob identity: withdrawn are "No blob identity crosses the boundary, ever. There is no `BlobId`" and the `audio.src = vocab.notes.blobUrl(note.id)` playback line. The recorder returns a `BlobId` at `stop`, the row's cell stores it, and playback goes through `epicenter.blobs.url(id)`. The row-that-fills rule, the `start` and `stop` semantics, the refusal of a `cancel` verb, and "a crash finishes it" stand.
- **Depends on, not yet built:** [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md) and [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md), both still Proposed. The nullable blob digest on `_replica_row_facts` does not exist yet, and this record cannot be built before it does. Accepted rather than Proposed because the decision is made and ADR-0184 would otherwise keep governing a model this contradicts.
- **Corrected 2026-08-04, before merge, at two clauses: `cancel` is deleted, and the application creates the row before `start`.** The first draft gave the recorder a verb that deletes a row it did not create, in a table it cannot read, belonging to a Lens it does not know; nothing else in the capability handle reaches across that line, and discard already has a spelling in the vocabulary that owns it. The second draft split naming from creating to protect a latency that does not exist: a row insert is a same-origin write into SQLite, and opening an input device costs more. Both corrections are restated in the Decision below, and a third clause is sharpened rather than changed: transcription returns text and never writes a field.
- **Relates:** [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md) (the recorder is contended and keeps a lifecycle; a blob is not and keeps none), [ADR-0178](0178-row-facts-and-value-facts-are-separate-relations-keyed-by-structured-coordinates.md) ("row documents and blobs are not a new address kind; they use the exact row address"), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md), [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md), [ADR-0016](0016-prewarm-the-cold-model-load-and-refuse-the-rest-of-the-latency-menu.md)

## Context

ADR-0184 was written when bytes could exist before an owner did. A capture
streamed into a private staged WAV under an identity of its own, and an
application later claimed it. Everything else in that record follows from that
one premise: the claim, the staging identity that `cancel` burns, and the rule
that host death loses active capture, because staged bytes nobody has claimed
belong to nobody and cannot be reunited with an owner on the next launch.

That premise stopped being true. ADR-0173 gives every live row one latent blob
slot addressed by the row itself, and ADR-0178 states the consequence directly:
"row documents and blobs are not a new address kind; they use the exact row
address." A recording therefore has somewhere to belong from the first
millisecond, and a row with no bytes yet is an ordinary row rather than a
special state.

ADR-0184's refusal of "any restore, repair, acknowledgement, manifest,
catch-up, or pending-interruption inbox" was correct for its model and is the
clearest evidence for changing it. Under staging, an interrupted capture is an
orphan with no owner, so reuniting it needs a whole surface, and refusing that
surface means losing the audio. Under a row, the orphan is not an orphan. It
already knows exactly where it belongs, so the inbox is unnecessary rather than
refused.

The cost of the old model is not theoretical. A four-hour recording lost
entirely to a crash is a different product from one that loses its last few
seconds.

## Decision

**A recording is a row that fills. The row exists first, the bytes accumulate
into its blob slot, and `stop` is what finalizes them.**

```ts
await epicenter.recording.start(rowAddress)
await epicenter.recording.stop(rowAddress)
epicenter.recording.current()   // { rowAddress, microphone, endedReason } | null
```

**No blob identity crosses the boundary, ever.** There is no `BlobId`, no claim
ticket, and no staging identity. The row address is the only name a recording
has, which is what ADR-0173 asks for when it says incomplete capture has "no
permanent blob identity."

**The row address is also the guard.** `stop` on a row that is not the current
recording fails rather than stopping someone else's, so a reloaded window cannot
end a recording it did not begin. The recorder keeps its lifecycle because it is
contended, one microphone and one slot, and a second `start` is still refused
with `Busy`. It does not keep a name of its own, because contention earns a
lifecycle and not an identity (ADR-0203).

### The application creates the row; `start` refuses one that is not there

You do not record a recording. You record into a note. The row is the
application's to make, and `start` names an existing one or fails.

That ordering costs nothing worth protecting. A row insert is a same-origin
write into SQLite whose sync obligation is asynchronous, and opening an input
device is the larger cost by an order of magnitude, so the latency ADR-0016
fights is the model load rather than a row.

### There is no `cancel`

Discard is `delete` on the row, which is terminal under ADR-0173 and takes the
bytes with it. A capture in flight ends because its destination stopped
existing, which is the host coordinating two things it already owns.

A recorder that could delete a row would be reaching into a Lens it does not
know, a table it cannot read, and a lifecycle that is not its own; nothing else
in the capability handle does that. The same line also repairs a failed `start`,
because a microphone that was denied and a take you threw away mean the same
thing: this note never happened.

New bytes still require a new row, exactly as ADR-0173 says, so a retake is a
new row rather than a second attempt at one slot.

### A crash finishes the recording

Startup recovery is not a new mechanism. It is the `stop` procedure, run against
what it finds:

```txt
find rows whose blob digest is null and that have a partial beside them
truncate to the last whole sample frame
patch the WAV length fields from the file size
hash, rename into place, write the digest to the row
```

**The search starts from a SQLite query and never from a directory scan.** The
blob filename is a hash of the canonical row address, so it is computable from
the row and not parseable back into one, which is the same one-way rule
ADR-0178 states for internal surrogates. The replica is the authority on what
exists; the directory is not, exactly as a token store rather than a directory
is the authority on which partitions exist (ADR-0201).

### What is promised, stated exactly

**You can lose the unflushed tail. You cannot lose the recording.**

ADR-0184's refusal of in-capture `fsync` and of periodic WAV header checkpoints
stands, so a kernel panic costs whatever the OS had not yet flushed. That is
seconds. The clause it was protecting, that a partial capture must not appear to
survive a crash, is withdrawn, because under a row it both can and should.

### What ADR-0184 keeps

Restated so this record stands alone: one host recorder; one slot, with a second
`start` refused as `Busy`; mono PCM16 streamed to disk so memory is flat in the
recording's length; applications neither select nor observe the capture rate;
`onEnded` carries a reason and never audio; `current` reports an unresolved
recording for as long as it is unresolved; and `stop` remains the only
publication path, with no second channel delivering audio anywhere else.

## Consequences

- **An app never handles bytes.** Create a row, `start`, `stop`, read it back. No
  blob id, no file path, no buffer, no publication step, and the same code for
  four seconds or four hours.
- **Transcription reads the row's bytes and answers text; it never writes a
  field.** A host that wrote the transcript would have to be told which of the
  application's declared fields holds one, and an application's schema is not
  the host's to know. The caller patches, which is also where trimming and
  transformation already live.
- Discard syncs a tombstone, which is heavier than burning a staging id and is
  correct: the row existed.
- A recording in progress is visible on another device as a row with no bytes
  yet, which is true and useful rather than litter.

```ts
const { data: note } = await vocab.notes.create({
  title: 'Untitled',
  recordedAt: InstantString.now(),
})
const address = vocab.notes.address(note.id)

const { error } = await epicenter.recording.start(address)
//  -> RecorderBusy | MicrophoneAccessDenied | NoMicrophone | SlotAlreadyFilled
if (error) return void vocab.notes.delete(note.id)

const { data: stopped } = await epicenter.recording.stop(address)
await vocab.notes.patch(note.id, { durationMs: stopped.durationMs })

const { data: transcript } = await epicenter.transcription.transcribe(address)
if (transcript.outcome === 'transcribed') {
  await vocab.notes.patch(note.id, { transcript: transcript.text })
}

audio.src = vocab.notes.blobUrl(note.id)   // playback: a URL, never bytes
await vocab.notes.delete(note.id)          // discard, and the audio goes too
```
- This cannot ship before the digest column exists. It is the second consumer of
  that column, after row-owned blobs themselves.
- **What this forecloses:** a claim or adoption verb, a `cancel` verb, an
  unclaimed-recording inventory, a staging directory, a recording identity
  separate from its row, a recorder that creates or deletes rows, a transcription
  route that writes an application's fields, and any startup path that scans
  `blobs/` to decide what to do.

## Considered alternatives

- **Keep staging and add crash recovery to it.** Rejected: recovering an orphan
  means deciding which application it belonged to, which is the
  pending-interruption inbox ADR-0184 refused for good reasons that still hold.
  The row removes the question rather than answering it.
- **Create the row only at `stop`.** Drafted, and it is self-defeating: if no row
  exists during capture, a crash leaves a partial file that recovery cannot find,
  because recovery queries the replica. It would have shipped as a bug.
- **Let `start` create the row itself.** Rejected on ownership rather than
  latency. An earlier draft rejected it on latency and was wrong: a local insert
  is far cheaper than opening an input device. The real objection is that a
  recorder which creates rows also has to decide what fields they carry, which
  Lens they belong to, and what happens to them when capture fails, none of
  which it can know.
- **Keep `cancel`, but let it discard the bytes and leave the row.** Rejected:
  it keeps the tombstone away and leaves a titled, empty note behind, and it
  still puts the recorder in the business of having opinions about rows. It also
  invents a state ADR-0173 has no law for, a slot that was used and abandoned.
- **Give the recording a token distinct from its row.** Rejected: two names for
  one thing, which ADR-0204 refuses one layer up for the same reason. The row
  address already discriminates, and a second identity would need its own
  lifetime.
- **Periodic WAV header checkpoints so a partial file is playable in place.**
  Rejected, as in ADR-0184. `stop` repairs the header from the file size, and
  recovery runs `stop`, so the bytes are recoverable without paying seeks during
  capture for a file nothing reads directly.

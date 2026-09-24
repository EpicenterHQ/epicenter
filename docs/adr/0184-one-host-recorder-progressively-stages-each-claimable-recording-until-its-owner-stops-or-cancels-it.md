# 0184. One host recorder progressively stages each claimable recording until its owner stops or cancels it

- **Status:** Superseded
- **Current target:** [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) and [ADR-0366](0366-a-recorder-captures-into-its-explicit-local-blob-destination.md) supersede ADR-0205's recovery promise. This record remains historical; its single global slot is not reinstated.
- **Date:** 2026-07-27
- **Superseded by:** [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it.md), which makes a recording a row that fills rather than staged bytes awaiting a claim. Most of this record survives there verbatim: the one recorder, the single slot and its `Busy` refusal, the flat-memory streaming WAV, the refusal of a second audio channel, and the refusal of in-capture `fsync` and periodic header checkpoints. What ADR-0205 withdraws is the claimable-recording premise: the staging identity, the claim, and the clause that host death loses active capture.
- **Relates:** [ADR-0016](0016-prewarm-the-cold-model-load-and-refuse-the-rest-of-the-latency-menu.md), [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md), [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md)

## Context

The host recorder was built for dictation: it accumulated captured audio in an
unbounded in-memory buffer and turned it into a WAV at stop, and a capture that
died under it discarded everything it held. Epicenter has now chosen meetings as
a host capability, and at hour scale both of those become unacceptable: an hour
at 48 kHz is hundreds of megabytes of resident audio, and losing all of it
because a microphone was unplugged at minute fifty is the worst failure the
product has. Git archaeology settled the one open question. An earlier
progressive writer was removed because a separate long-form *mode* had no
callers, not because progressive capture was slow, and a bench (`304db923c1`)
measured the stop-path difference between handoff shapes at under 4 ms for a
two-minute clip. So progressive capture is not a performance trade; it is just
the shape that was abandoned for an unrelated reason.

## Decision

One host recorder progressively stages each claimable recording until its owner
stops or cancels it.

- **One path, no modes.** Every recording, four seconds or four hours, streams
  mono PCM16 into a private staged WAV as it is captured. Memory is flat in the
  recording's length. The host prefers 16 kHz and falls back to the closest rate
  the selected device supports. Applications neither select nor persist a
  capture rate, see no PCM, and never learn the staged rate.
- **The recorder holds one recording, and holding it survives its capture.** A
  capture that ends without anyone asking (device disconnected, permission
  revoked, stream failed, storage failed) ends the capture only. The recording
  keeps the one slot, keeps its staged bytes, and keeps its owner; `current`
  keeps reporting it, now carrying the reason. A competing `start` is refused
  with `Busy` until the owner resolves it or its window is destroyed.
- **The ended signal carries nothing.** `onEnded(reason)` never carries audio, a
  blob, or a result. The ending is state, not a message the host owes anyone:
  `current` reports it for as long as the recording is unresolved, so a client
  that could not have observed the moment reads it instead. That read is the
  whole mechanism; nothing is queued, acknowledged, or replayed.
- **`stop` is the only publication path.** It finalizes and atomically publishes
  whatever the staged file can still be made into, on either side of the capture
  ending. It can also fail: a capture that ended because storage failed may not
  be finalizable at all, and then `stop` reports the loss and releases the slot
  rather than publishing a file whose header does not describe its bytes.
  `cancel` deletes staging and burns the id, and publishes nothing, ever.
- **Host death loses active capture.** Startup deletes stale recorder staging and
  does nothing else with it.

This decision explicitly refuses, and these refusals are the reason it is small:

- a second channel that delivers a recording's audio anywhere but `stop`;
- any restore, repair, acknowledgement, manifest, catch-up, or pending-
  interruption inbox: the interrupted recording *is* the pending state;
- periodic WAV header checkpoints or `fsync` during capture, which would imply
  a partial capture survives a host crash;
- a streaming resampler in the capture path;
- an application-selected long-form or meeting mode;
- a public dropped-chunk counter or capture health field;
- direct in-memory transcription handoff, which stays refused under ADR-0016.

## Consequences

- Meeting-scale recording costs what dictation costs. Resident audio is one
  bounded callback queue and one buffered writer, whatever the duration.
- A microphone dying mid-recording no longer destroys the recording. What was
  captured before it died publishes through the ordinary stop, lands in history
  like any other dictation, and the person is told why it ended early.
- Storage failure is the one ended reason whose audio may not survive after all.
  A volume that could not take the samples may not take the header patch either,
  and an unfinalizable file is not a recording. So the notice for an ending says
  what happened to the *capture* and stops there, and the stop's own outcome is
  what speaks for the audio: two facts, each stated when it is actually known,
  rather than one promise made before either is.
- One ended recording occupies the host's single recorder until its owner
  resolves it, so a window that ignores the ending blocks every other window from
  starting. That is the accepted cost of never silently discarding audio; owner
  window destruction is the escape hatch, and it cancels.
- Blobs are mono PCM16 at the host-selected device rate rather than f32 held in
  memory. The host prefers 16 kHz because retained audio primarily supports
  transcription and review, then chooses the closest rate the device can
  actually capture. Local transcription already decodes arbitrary rates to 16
  kHz and cloud upload owns its own conversion to 48 kHz Opus. The staged rate
  is private mechanism, not application config or contract.
- A stalled disk costs dropped chunks (about ten milliseconds of audio each)
  rather than a stalled audio thread. Blocking the callback would not have saved
  the recording and would have glitched every other sound on the machine. A
  capture device that will not finish closing costs the last few milliseconds of
  tail on the same reasoning: a stop waits a bounded moment for the audio backend
  to release the microphone, then publishes without it rather than hanging.
- A recording is capped at what a RIFF header can describe, about twelve hours of
  mono capture. The writer refuses before the header would wrap.
- ADR-0173 is unchanged and unamended. Staging is exactly its "temporary staging
  state and no permanent blob identity"; the publish rename remains the single
  write-once admission of a finalized stream.
- ADR-0016 is unchanged. Prewarm still fires at capture start, and transcription
  still reads the published blob rather than receiving PCM.

## Considered alternatives

- **Stream-resample to 16 kHz during capture.** Rejected: a stateful resampler on
  the write path to save disk bytes that the decode and encode paths already
  convert anyway.
- **Deliver the captured audio on the ended event.** Rejected: it turns a signal
  into a second result channel, and every consumer then has two ways to receive a
  recording that must agree forever.
- **Keep discarding audio when capture dies.** Rejected: that is the loss this
  decision exists to remove.
- **Checkpoint the WAV header periodically so a crashed host leaves a readable
  file.** Rejected: it promises host-crash recovery, and the recovery surface
  that promise implies is larger than the whole recorder.
- **A separate long-form mode beside the dictation path.** Rejected once already
  for having no callers. Two paths is the thing that made the first progressive
  writer disposable.

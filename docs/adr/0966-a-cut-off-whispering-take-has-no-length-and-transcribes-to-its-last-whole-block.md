# 0966. A cut-off Whispering take has no length and transcribes to its last whole block

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0962](0962-whispering-8-writes-every-file-inside-its-folder-at-or-beside-its-final-path.md) at "Whispering plays it and reads its length with `audioDurationMs`" and at the open question of what Whispering does "when its transcription decoder ... refuses a cut-off file": Whispering reads no length from a take's bytes, and its decoder reads a cut-off take to its last whole block. Cloud transcription of a cut-off file stays open there.
- **Relates:** [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (audio with no note lists as an untitled recording).
- **Unbuilt:** all of it. The branch `whispering-keeps-its-recordings-local` builds it.

## Context

ADR-0962 records a take at `recordings/<id>.webm` from its first second.
Stop finishes the file in place and then writes `recordings/<id>.md`, whose
`durationMs` field is the take's length. A crash leaves the file as it was:
whole Clusters, perhaps a torn block at its end, no Duration, and a Segment
of unknown size (`01 FF FF FF FF FF FF FF`). It has no note.

ADR-0962 said Whispering reads such a file's length with `audioDurationMs`
(`whispering-keeps-its-recordings-local:apps/whispering/packages/recorder/src/container.ts` before the build deleted it), and left open what
the transcription decoder does with the torn block. Building it showed two
things:

- Nothing in the app called `audioDurationMs`. The list and the detail pane
  take a recording's length from its note's `durationMs`.
- Symphonia 0.5's WebM reader (symphonia-format-mkv 0.5.5) refused the torn
  block with a `DecodeError` whose message contains "past master element", so
  `transcribe_audio` failed on every take a crash cut off. On a finished WebM
  that lost its end, it panicked when its SeekHead pointed past the end, and
  the release build (`panic = "abort"`) closed Whispering.

## Decision

**A take's length comes only from its note.** Stop writes `durationMs` into
`recordings/<id>.md`. Whispering reads no length from audio bytes:
`container.ts` and `audioDurationMs` are deleted. A cut-off take has no note,
so it lists as an untitled recording with an empty length.

**The decoder reads a cut-off take to its last whole block.** Whispering
decodes with Symphonia 0.6. Its WebM reader reports the torn block at the
end of a Segment of unknown size, which is how Stop leaves a take it never
finished, as an unexpected end of file; in
`whispering-keeps-its-recordings-local:apps/whispering/packages/transcription/src/audio/decode.rs` an
`std::io::ErrorKind::UnexpectedEof` ends the audio. A Segment whose stated
size runs past the file's bytes is a finished file that lost its end, and
the reader refuses to open it: an error, never a shortened transcript.
Nothing rewrites the file.

## Consequences

- A take a crash cut off plays, lists with no length, and transcribes up to
  its last whole block. The torn block's audio is lost from the transcript.
  WKWebView shows the take's length once it loads; another player may show
  none.
- About 420 lines of WebM parsing in TypeScript are gone.
- The rule rests on how Symphonia 0.6's WebM reader ends a file, not on an
  error message's wording. Tests hold it there: the transcription crate cuts
  a finished WebM with a SeekHead and Cues at every byte and expects an error
  at each cut, and decodes a torn take; the recorder crate cuts a take at
  every 29th byte and decodes each cut. A Symphonia upgrade that changes
  either behavior fails those tests.
- A damaged finished file fails to transcribe rather than returning a
  shortened transcript, whichever program wrote it.
- Symphonia 0.6 also trims MP3 and AAC encoder delay and padding by
  default.

## Considered alternatives

- **Read the length from the bytes (`audioDurationMs`).** Nothing showed it,
  and a take with no note is rare.
- **Write a note for a note-less take at launch, with its length.** A
  recording's note is written once, after Stop (ADR-0894); a note for audio
  Stop never finished would break that.
- **Repair the file so every reader accepts it.** ADR-0962 decided nothing
  repairs a take.
- **Stay on Symphonia 0.5 and match its "past master element" message.**
  The rule would depend on an error's wording, and 0.5 panics on a finished
  WebM cut off before what its SeekHead points to, which needed a check of
  its own in `decode.rs`.
- **Treat any decode error at the end as the end of the audio.** Damage in a
  finished file would return a shortened transcript with no error.

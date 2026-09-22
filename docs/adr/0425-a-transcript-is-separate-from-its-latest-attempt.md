# 0425. A transcript is separate from its latest attempt

- **Status:** Proposed
- **Date:** 2026-09-22
- **Implementation note (2026-09-23):** Whispering now records transcription status, completion time, and the latest error separately from `transcript`. The nullable transcript field, explicit attempt identity, and complete consumer migration are not implemented.
- **Unbuilt:** Nullable Whispering transcript field, explicit attempt identity and stale-completion fencing, and consumer migration that preserves prior text through retranscription failure.

## Context

Whispering stores audio in LocalBlobs and its metadata in a `recordings` row.
`transcript` is a string initialized to `''`. That value cannot distinguish an
untranscribed recording from a completed transcription of silence.

## Decision

A recording's transcript is `string | null`. `null` means no transcript has
been produced. An empty string is a completed transcript containing no text.
The transcript stays on the recording row; recording history is a view of those
rows, not another history resource.

Attempt state describes the latest requested transcription. The target semantic
states are `not-started`, `running`, `succeeded`, and `failed`. A fresh recording
has `transcript: null` and no requested attempt. A selected model or automatic
transcription preference alone does not mean an attempt has started.

Serialize attempts per recording or fence publication with an attempt identity.
An older completion must not overwrite a newer attempt's state or text. This
requires no persistent job framework.

Starting another attempt retains the previous transcript. Success replaces it,
including with an empty string. Failure retains it and records the failed
attempt. A page interrupted during an attempt cannot claim completion. Recovery
must distinguish persisted attempt metadata from a live operation in this page;
the state field alone cannot prove that compute is still running.

Stop saves audio locally, creates and persists the recording row, and then
starts transcription automatically by default. The row begins with
`transcript: null`; its attempt becomes running only when transcription starts.
The saved recording is available for playback while transcription runs. Manual
transcription and retranscription operate on that same saved recording.
Transcription failure cannot undo the saved recording. A successful transcription
whose row update fails returns the usable text with the storage failure. Only a confirmed
write permits claiming that the text was saved to history.

A remote transcription provider receives the saved audio for inference. This
does not require creating a retained remote blob or storing an audio URL.
Explicit audio upload is a separate workflow. Transformations are outside this
recording and transcription workflow.

This decision changes the target schema and application behavior. It does not
authorize rewriting existing user data. Implementation must distinguish old
empty strings with known successful attempts from rows with no transcript;
ambiguous old values must not be silently reclassified. Any required migration
must be reported separately before it runs against user data.

## Consequences

UI, search, export, retranscription, and pipeline callers must handle nullable
text. Checks such as `if (transcript)` cannot establish transcription success.
Attempt state does not determine whether usable prior text exists.

Transformations and recipe output storage remain separate product work. This
decision introduces no transcript table, event log, or generic job system.

## Considered alternatives

- Use `''` for both absence and successful silence: forces every content reader
  to consult attempt metadata to understand whether text was ever produced.
- Clear text when retrying: destroys usable output before replacement exists.
- Create a separate transcript-history primitive: adds ownership and schema
  boundaries without a requirement for multiple retained transcript versions.

## Verification

Cover default Stop ordering (durable audio, durable row, then transcription),
new recordings, successful silence, failed first attempts, failed
retranscription retaining prior text, usable text after failed history writes,
and reopening after an interrupted attempt. Verify nullable consumers rather
than only the schema declaration.

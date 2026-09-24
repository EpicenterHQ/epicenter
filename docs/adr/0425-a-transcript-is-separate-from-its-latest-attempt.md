# 0425. A transcript is separate from its latest attempt

- **Status:** Proposed
- **Date:** 2026-09-22
- **Implemented portion (2026-09-24):** Whispering keeps successful Local results, retries sequentially, previews cleanup replacements, and lets the recording detail view select a result and its Original or Cleaned text.

## Context

Whispering saves Local audio but keeps one `transcript` and one nullable
`polishedTranscript` on each recording. Retranscription replaces the text, so
trying another model can erase a useful earlier result. The detail view also
edits `transcript` directly and clears `polishedTranscript`. Speech results and
the person's writing share one mutable field.

The person wants to replay Local audio and transcribe it more than once.
Whispering can keep those results without becoming another editor. The text
chosen for writing can instead be copied to its destination or explicitly added
to Capture.

## Decision

**A Local recording retains the original text of each successful transcription.**
The recording holds one Local `audioBlobId` and its recorded instant.
A Local `transcriptions` table holds zero or more results with their own IDs,
`recordingId`, attempt start order, immutable `rawText`, nullable current `cleanedText`,
and the selected connection and model as descriptive context. An empty string
is a successful transcription of silence; no result means no successful text is
available. Cleanup is a presentation of that result, not another transcription. If
cleanup returns the original text unchanged, there is no distinct Cleaned
version to display.

**Only one transcription or cleanup operation may be active for one recording.**
Another recording can process independently. A retry of saved audio starts a
new attempt and appends a result only after successful transcription. A failed
attempt leaves every successful result intact and needs no durable failure row.
The active state and latest error can be shown during the page lifetime; the
saved audio remains available for another retry after reload. If local
persistence of a completed result is unconfirmed, retain that result and its ID
for a save-only retry without another inference request.

**Whispering does not let a person edit transcription text.** `rawText` is
immutable; `cleanedText` holds at most one accepted machine output for that
original and can be replaced by a later cleanup retry. There is no
`editedText`, local text draft, preferred-result pointer, or general processing
graph. The recording detail view has one reading pane. It initially selects the
newest successful result and its cleaned text when available, otherwise its
original text. A temporary result selector and Original/Cleaned choice let the
person inspect earlier output. Copy and Add to Capture use exactly the visible
text, fixed when the action starts. The selector appears only when multiple
results exist, and the text choice appears only when cleanup produced a result.

History retranscription uses the same optional cleanup operation as live
dictation, but it only saves the new result. It does not paste at the cursor or
write to the clipboard automatically. Live dictation may deliver its completed
text once. Automatic cleanup may fill `cleanedText` for a new transcription.
A person can retry cleanup on an existing Original without retranscribing the
audio. The retry previews its candidate beside the current Cleaned version, or
beside the Original when none exists. Only explicit acceptance writes the
candidate to the current cleaned slot. An accepted candidate identical to the
Original clears that slot. A skipped, canceled, or failed
retry leaves the current value intact. The preview is temporary, and Whispering
keeps no cleanup history.

Deleting a recording removes its Local results through the recording workflow.
Deleting one result leaves the audio and the other results intact. Local audio
and transcription history do not synchronize.

## Consequences

The current scalar recording text, status, and error fields and their readers
give way to result rows and page-owned operation state. The current transcript
editor, dirty state, Save control, and unsaved-change prompt disappear. A person
who wants to correct a word edits the pasted text in its destination or adds a
chosen version to Capture and edits that entry there. Whispering does not keep
that correction as a transcription.

The clean break requires no migration, legacy result wrapper, or preservation
of the previous scalar text. It does not delete stored bytes as a side effect
of adopting this record. Changing cleanup instructions can lead to a new cleanup
request for the same Original without changing its words.

## Considered alternatives

- Keep one mutable transcript: a retry can erase a useful prior answer.
- Keep a manual `editedText` on every result: gives Whispering a second writing
  surface with draft, save, precedence, and conflict behavior.
- Run overlapping transcription requests for one recording: adds ordering and
  late-result rules without helping the sequential compare workflow.
- Keep a durable log of failed attempts or cleanup versions: adds history
  that the person does not need to choose among successful transcriptions.

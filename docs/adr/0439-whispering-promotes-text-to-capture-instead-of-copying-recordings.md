# 0439. Whispering promotes text to Capture instead of copying recordings

- **Status:** Proposed
- **Date:** 2026-09-23
- **Amends:** [ADR-0428](0428-whispering-recordings-reference-audio-in-their-containing-store.md) at new Personal recording copies: Local capture and store-relative reads remain, but `Save to Personal` stops creating audio-bearing Personal recordings.
- **Implemented portion (2026-09-23):** Whispering's Save to Personal action and Personal recordings route were removed.
- **Implemented portion (2026-09-24):** Desktop Whispering offers Add to Capture for a selected Original or Cleaned result. A Local request freezes the text, recording date, and Account. The Capture document claims the request key before creating the root, confirms local persistence, and returns its ID. Open in Capture waits for an acknowledged exact selection and keeps Capture drafts by destination.
- **Unbuilt:** A background handoff between the separately hosted browser apps. The browser build does not offer Add to Capture.

## Context

ADR-0428 made `Save to Personal` copy a Local recording's audio and values into
an independent Personal recording. Whispering still captures and imports into
Local first. The person can re-transcribe that Local audio, while the Personal
copy creates a separate audio archive with its own row and blob lifetime.

Capture gives kept text a different destination. Text selected from a
transcription or another text result can become an editable capture in the
account-backed Capture inbox. The person does not need a second audio-bearing
recording to continue that writing on another device.

## Decision

**Whispering records audio and transcription results in Local; Add to
Capture copies the visible text chosen by the person.** A recording, its audio, and its Local
results remain usable for playback and further transcription after promotion.
Whispering does not upload the audio, create a Personal recording, or keep a
required source link in the capture. It never promotes every transcript
automatically.

The action is available on a selected Original or Cleaned result in recording
detail. It fixes the displayed text, recording's `recordedAt`, and Account before
asynchronous work. The Capture document that owns the account-backed Capture
store creates one independent root capture from that frozen request. Whispering
does not open a competing Capture store, choose an existing capture, or split
the selected text into thoughts. The person can add thoughts in Capture.
A confirmed capture retains its ID for save retry. Capture claims a request key
before creating its root, so replay cannot create a second root even if a write
stops partway through. An ambiguous creation without a known capture ID requires
inspection before another submission; a lost response never authorizes another
creation under a new key. Sign-out fences the attempt; a new Account
never receives it implicitly.

Promotion leaves the person in Whispering. Creating the capture does not reveal
the Capture window, change its selection, or touch an unsaved draft. A completion
notice and the current
recording detail offer **Open in Capture** for the exact new capture, where its
text is editable. This link does not create a permanent relationship with the
recording. Do not claim the browser can open a capture while its separate
replica has not received it; show pending sync or make the destination wait for
the known capture rather than treating it as absent. Opening an already mounted
Capture document must preserve its unsaved draft and the draft's intended
destination. A fleeting toast is not the only path to the capture.

**New Personal recording copies stop at the cutover.** Replace Whispering's
`Save to Personal` action with Add to Capture. Remove the Personal recordings
route and its audio copy path in the clean break. No migration, legacy read or
export path, or automatic conversion of existing Personal rows is promised.
This record does not instruct a destructive deletion of stored bytes. Capture
remains a selected writing inbox rather than an automatic recording archive.

Automatic cleanup and the ownership of general selected-text commands are
separate decisions from promoting a chosen result.

## Consequences

The Capture app can show promoted writing on another device without obtaining
the source audio. Editing or deleting the Local recording does not rewrite or
delete that capture; editing or deleting the capture does not change the recording.
The promotion action makes no hosted blob publication. An older recording's
promoted capture appears under its original date, so opening the exact capture is
more useful than sending the person to the root timeline.

New recordings cannot be replayed or re-transcribed on another device through
Whispering Personal. Losing the Local device can lose its audio and unpromoted
results unless the person backs them up separately. Retiring the Personal copy
path does not remove Whispering's synchronized speech settings or the general
hosted blob authority for other products.

## Considered alternatives

- Keep both Save to Personal and Add to Capture: retains two destinations for
  kept speech and the remote audio copy and playback machinery.
- Automatically convert Personal recordings into Capture entries: fills a
  selected-thought inbox with every old recording and obscures which text the
  person chose to keep.
- Move instead of copy: deleting Local audio would remove the ability to
  replay and re-transcribe after promotion.

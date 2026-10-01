# 0441. Whispering keeps speech evidence local and syncs only its speech profile

- **Status:** Proposed
- **Date:** 2026-09-23
- **Implemented portion (2026-09-23):** The Personal audio copy operation and Personal recordings view were removed.
- **Implemented portion (2026-09-24):** Whispering opens a distinct Personal speech profile with only known terms and instructions. Device settings remain in Local. Recipe and Personal recording declarations are absent from the active definitions. Recording-wide transcript fields have been retired. Local boot copies legacy text into result rows before the UI reads history; new transcription and cleanup writes target those rows.
- **Implemented portion (2026-09-24):** Desktop promotion sends only chosen text to Capture's owning document. Local request receipts retain the frozen text and Account for acknowledgement recovery; deleting a recording removes its result and receipt rows without deleting independent captures.
- **Unbuilt:** Browser promotion and end-to-end UI verification.

## Context

The former `whisperingDefinition` declared `recordings`, `recipes`, and all
settings once, then opened the same definition in Local and Personal. That made
Personal recording copies possible, but it also gives the synchronized store a
recordings table even after Whispering stops sending audio and transcription
history across devices. Device controls, speech terms, and editable writing
have different lifetimes and owners.

## Decision

**Whispering declares a Local recording store and a distinct Personal speech
profile.** Its Local definition retains the ID `so.epicenter.whispering` and
contains:

| Part | Data |
| --- | --- |
| `recordings` | One row per saved Local audio source: immutable `audioBlobId`, `recordedAt`, and playback metadata such as duration. Transcription text lives in result rows. |
| `transcriptions` | Zero or more successful results per recording: `recordingId`, attempt order/time, immutable `rawText`, nullable current `cleanedText`, and selected connection/model descriptors. An accepted cleanup retry may replace `cleanedText`. |
| `capturePromotions` | Local request receipts for explicit desktop handoffs. A receipt freezes chosen text, date, and Account, then retains the confirmed Capture ID. Recording deletion removes its receipts. |
| KV | Device controls: recording and delivery settings, shortcuts, local model and connection choices, and whether cleanup runs. |
| `.blobs` | The Local audio bytes referenced by `recordings.audioBlobId`. This is a borrowed resource of the opened store, not another synchronized dataset. |

The Personal speech-profile definition uses
`so.epicenter.whispering.speech`. Its KV holds the person's synchronized known
terms, transcription prompt, and cleanup instructions. It has no recordings,
transcriptions, audio, or Recipe table. Losing or failing to open the Personal
profile cannot prevent Local audio capture. Signed-in transcription may await
profile readiness for synchronized terms and instructions; signed-out
transcription uses defined defaults. A failed profile acquisition cannot create
an empty substitute Personal dataset. The profile is captured for one Account
and never retargeted after sign-out.

Capture remains a third, separate Personal definition,
`so.epicenter.capture`. Its `captures` table owns dated root text; its `thoughts`
table owns ordered text linked one level beneath a capture. Whispering adds
selected text as a root capture with `capturedAt` taken from the Local recording.
Further edits and thought ordering belong to Capture. There is no foreign key or
synchronized link back to the recording.

An inference connection catalog and provider credentials are independently
acquired resources, not fourth product content stores. A future saved-command
capability for selected text may have its own store; this record does not assign
that owner or place commands in either Whispering definition.

## Consequences

The desktop composition has three store handles across two documents: Whispering
owns Local and the Personal speech profile when signed in; the Capture document
owns Capture Personal. Local recording and transcription are available without
Capture. Opening Capture does not change the Local recording's owner or lifetime.

This is a clean break in store definitions. Existing Local recordings are user
data: the result-row cutover must keep their audio and transcript history
readable. Old Personal profile values are not migrated into the new profile;
the previous device-data download exposes only locally stored values. No
Personal audio export path or old-client compatibility mode is required. This
decision does not itself erase stored bytes. The former single
Whispering definition, Personal recording route and copy operation, and
recording-wide transcript fields are removed when the product cutover ships.
The general hosted blob authority remains available to other products; this
Whispering flow makes no hosted audio publication.

## Considered alternatives

- Open one Whispering definition in Local and Personal: leaves unused
  audio-bearing tables in the synchronized profile and permits a second
  recording destination to return through ordinary store calls.
- Put speech terms beside Local audio only: loses the existing cross-device
  benefit of a person's known names and prompt instructions.
- Put captures and thoughts in the Whispering profile: gives editable writing the
  recording product's schema and lifetime.

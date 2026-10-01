# 0440. Whispering cleans transcriptions and does not own general text actions

- **Status:** Proposed
- **Date:** 2026-09-23
- **Amends:** [ADR-0099](0099-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md) at automatic Polish and the Recipe library: optional light cleanup remains in Whispering; saved commands for arbitrary selected text do not belong to its store or transcription history.
- **Implemented portion (2026-09-24):** Whispering's Recipe store, picker, commands, shortcuts, and delivery settings were removed. Device cleanup controls remain available without Personal. Live and history transcription share cleanup; history saves without automatic delivery. Each result keeps its Original and accepted Cleaned text, and the recording detail offers a preview before accepting a cleanup retry. Product-facing Polish labels now say cleanup.
- **Unbuilt:** End-to-end UI verification of the cleanup retry preview.

## Context

ADR-0099 replaced Transformations with a speech-term Dictionary, automatic
Polish, and portable Recipes. In the current app, live dictation runs Polish,
but retranscribing a saved recording bypasses it. Recipes are single saved
instructions used on selected or clipboard text, including text unrelated to a
recording. Treating every Recipe as a step after Polish does not describe that
caller.

The intended Whispering workflow is narrower. It records audio locally,
transcribes it, and can deliver usable text at the cursor. A person can run
saved commands on selected text anywhere, but that capability has no reason to
own or be owned by a recording.

## Decision

**Whispering may run optional light cleanup on each successful
transcription.** The same result-producing operation serves live dictation and
history retranscription. It takes the original transcription as data and tries
to fix punctuation, fillers, spelling, and spoken self-corrections while keeping
the speaker's wording and intent. This is called **cleanup** in the product;
`Polish` is retired for this speech step. The instruction is a best-effort model
constraint, not a guarantee that meaning never changes. The original text
remains inspectable. A disabled, unavailable, canceled, or failed initial cleanup
produces no Cleaned version and never prevents the Original from being used.
An unchanged cleanup response likewise adds no duplicate visible version.

The device chooses whether cleanup is enabled and which completion connection
and model it can use. Synced speech instructions and known terms can inform the
operation. The terms are recognition and spelling hints, not words to study or
a deterministic replacement table. Whispering does not automatically apply
speech-term hints to arbitrary selected text. A person can retry cleanup on a
saved Original without another transcription. Whispering shows the candidate
against the current Cleaned version, or the Original when none exists, before
the person chooses whether to use it. Failure or dismissal preserves the current
value. Each transcription stores only its current accepted Cleaned version, with
no durable cleanup-run history.

**General saved text commands belong to a separate capability.** Whispering
may later invoke such an action on text the person explicitly selects, just as
another app may, but Whispering's recording store does not own the command
library or archive its runs. The command's name, synced store, trigger, and
output behavior require their own decision. The current Recipe picker and
`recipes` table are removed from the clean-break Whispering model; this does
not decide that selected-text commands should cease to exist.

Live dictation delivers the completed Original or Cleaned text once according
to its output setting. Retranscribing from recording history saves a result
without automatic cursor or clipboard delivery. These callers share speech
processing, not delivery behavior.

## Consequences

Whispering's speech path becomes recording, transcription, optional cleanup,
and delivery when the caller is live dictation. It has no general pipeline of
Recipes, no auto-pinned command, and no local history of arbitrary text actions.
Retiring the current Recipe table and UI is a breaking change with no migration
or compatibility promise. A future selected-text action product may require
another synced store; it is not a fourth store in Whispering's first cutover.

## Considered alternatives

- Keep `Polish` as the name: suggests broader rewriting than the automatic
  speech step is meant to perform.
- Run cleanup only on live dictation: makes history retries return a different
  kind of result for the same audio.
- Keep Recipes inside Whispering because its picker is the first caller: makes a
  general selected-text command library depend on a speech product.
- Keep every cleanup run in its own table: adds durable version comparison and
  another selection axis when the person only needs to accept or reject a retry.

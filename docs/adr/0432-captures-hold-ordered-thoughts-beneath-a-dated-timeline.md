# 0432. Captures hold ordered thoughts beneath a dated timeline

- **Status:** Proposed
- **Date:** 2026-09-23
- **Implementation:** The two-table Capture model, manual thought ordering, and web interface are implemented in the current checkout. Earlier `entries` remain readable in a recovery area; Markdown handoff and Whispering promotion remain later work.

## Context

A person wants to keep a dinner, an idea, or a pasted invitation without first choosing a filing system. The dated item may need only a line of text or may contain a full description. Later, the person may notice several separate thoughts related to it and arrange those thoughts in an order that helps them write.

The first Capture slice represented every item as the same recursively openable, timestamped `entry`. The dinner example exposed a simpler relationship: the ideas from a dinner are usually siblings, not containers for one another. Their chosen order matters more than their individual capture times. The earlier recursive implementation supplied the sync and editing path that the current cutover retains.

## Decision

**Capture has a dated root timeline of captures. A capture has editable text and an ordered, one-level list of independently editable thoughts.** The root accepts an event, a free idea, selected Whispering text, or any other writing the person wants to keep. “Add a capture” is the action at the root. The word *event* does not define a separate type.

```text
Timeline
  Sep 24  Dinner with Sebastian
  Sep 23  An idea for Whispering

Dinner with Sebastian
  [editable capture text, which may be one line or a full description]

  Thoughts
  ≡ Owning the outcome
  ≡ Moving to Singapore
  ≡ A question for next time
```

The timeline sorts captures by `capturedAt` descending, then ID ascending. `capturedAt` is when the item was captured, not a date parsed from its text. A pasted invitation may mention a future event date without moving the capture to that date. A recording promoted from Whispering uses the recording's `recordedAt`. Adding or editing a thought does not change the capture's position in the root timeline.

The capture body holds its complete editable text. It may be empty. The interface derives a preview from its first nonblank line and uses a neutral placeholder when empty. There is no required title or description field. A thought also has an editable plain-text body, which can be a line or a paragraph. Thoughts may look like bullets, but they are separate items so a person can edit, reorder, move, or delete one without parsing a list inside the capture body. Thoughts cannot contain other thoughts.

The logical model is one Personal store, `so.epicenter.capture`, with two tables:

| Table | Row data | Body |
| --- | --- | --- |
| `captures` | Minted ID and immutable `capturedAt` | Editable plain text |
| `thoughts` | Minted ID, `captureId` reference, and sortable position | Editable plain text |

The capture stores no child-ID array. The thought's `captureId` determines membership; its position determines manual order, with ID as a deterministic tie-breaker. Reordering preserves the thought's identity and text. Concurrent offline reorders converge to a deterministic order but need not preserve either device's exact full permutation. There is no visible timestamp requirement for thoughts and no processed flag, recording pointer, or stored destination file link.

A thought can move to another capture without changing its identity or text. A capture cannot become a thought or move beneath another capture. The one-level rule removes recursive navigation, ancestor checks, cycle resolution, and subtree moves. Missing captures and deletion are covered by [ADR-0434](0434-capture-keeps-unavailable-thoughts-visible.md).

### Relationship to Whispering

Whispering keeps Local audio and transcription results separate. An explicit **Add to Capture** action copies the exact selected Original or Cleaned text into a new root capture, using the recording's `recordedAt` as `capturedAt`. It copies no audio and requires no lasting source link. The text becomes independently editable in Capture; later edits do not rewrite Whispering's Local result. One recording is not automatically split into thoughts, and Whispering does not choose a parent capture.

Add to Capture replaces Whispering's Personal recording-copy path. It does not migrate or automatically import old recordings. The first Capture release requires sign-in and one Personal inbox, as described in [ADR-0433](0433-capture-opens-one-account-backed-inbox.md).

### Into Markdown

The person may copy or download a capture's text and its thoughts in their chosen order, then incorporate that material into Markdown writing. [ADR-0435](0435-capture-hands-markdown-out-as-an-explicit-snapshot.md) defines the handoff. Copying leaves Capture unchanged. The person decides whether and when to delete the source; there is no automatic archive or processed state.

## Consequences

The root timeline shows starting points, not every later edit or thought. The one-level relationship makes the common dinner case direct and lets thoughts have independent identities without presenting a nested notebook. Someone who wants to develop a thought into a separate dated context creates a new capture and can move that thought there; the product does not turn every thought into another timeline.

Two tables remove the recursive forest machinery from the current product. The old `entries` declaration remains as a read-only recovery source under the same store ID. The web app displays every readable earlier entry and lets a person copy its text into the new model. It does not automatically convert old rows because independent offline conversion can duplicate them and a repeat conversion can recreate explicitly deleted writing. The first browser proofs used disposable data, but that does not establish every opened replica is disposable.

## Considered alternatives

- **Recursive entries:** Allow an arbitrary hierarchy but require cycle resolution, subtree moves, recursive deletion, and arbitrary-depth export for a use case the person does not expect to use often.
- **One table with capture and thought variants:** Saves a table declaration but leaves role-dependent fields and checks. No caller requires the two roles to share a row type.
- **One plain-text body containing bullet points:** Makes editing easy but cannot independently move or reorder multiline thoughts without interpreting authored text.
- **One structured capture document with nested thought nodes:** Could delete the whole aggregate together, but requires a new structured editor and changes the existing guarantee that a thought added offline can survive deletion of a capture.
- **A required title and description:** Adds fields to fill before capturing. The editable text already supplies a useful preview.
- **A separate event type or event date:** Treats an invitation as a calendar obligation rather than material captured for later thought. Event details can remain in the text.

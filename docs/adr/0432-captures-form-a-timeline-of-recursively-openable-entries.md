# 0432. Captures form a timeline of recursively openable entries

- **Status:** Proposed
- **Date:** 2026-09-23
- **Unbuilt:** The capture application, its store, recursive entry views, moves, Whispering text handoff, and integration into a Markdown workflow.

## Context

A person wants to capture a thought before deciding how to organize it. Later,
they may open that thought and add another underneath it. Dinner can contain a
conversation, which can contain an idea, which can contain further observations.
Every one of those entries should support the same interaction.

Whispering produces usable text from speech. Keeping a thought gives that text
a purpose beyond the recording. The capture application must also accept typed
text without requiring a recording, title, or description field. It is an inbox
for thoughts that will be integrated into the person's Markdown writing, rather
than their permanent notes home.

## Decision

**The capture app owns timestamped entries. Every entry can be opened to read
and edit its text and capture more entries beneath it.** The root timeline shows
only top-level entries, newest first. An opened entry shows only its immediate
children, also newest first. The same view repeats at every depth.

One recording can produce one entry containing several thoughts. Whispering
does not automatically split the text into a hierarchy. The person creates
structure by choosing where to add the next entry or moving an existing entry.

### A day in the app

```text
Timeline
  Today
    19:40  Dinner with Sebastian                 [open]
    14:10  An idea for Whispering
  Yesterday
    09:20  Morning walk

Timeline / Dinner with Sebastian
  Dinner with Sebastian
  [editable text]
  [Capture a thought here…]

    20:15  Owning the outcome                    [open]
    19:55  Moving to Singapore
    19:42  The consulting conversation

Timeline / Dinner with Sebastian / Owning the outcome
  Owning the outcome
  [editable text]
  [Capture a thought here…]

    20:30  Building something you keep working on
    20:22  Sebastian's example
```

The heading and list preview come from the entry's text; these sketches do not
introduce a required title property. Breadcrumbs provide a path back. Date
headings group entries for display; a day is not a stored parent entry.

Creating from the timeline makes a top-level entry. Creating within an entry
makes its child. Dictating into the existing text editor edits that entry instead.
Opening an entry does not change its capture time. Adding a child does not move
its parent to the top of the timeline. A Friday addition beneath Tuesday's entry
appears inside that entry, not as another top-level Friday capture.

**Move** lets the person choose another entry as the parent or return the entry
to the timeline. Moving preserves the entry's identity, text, capture time, and
entire subtree. Descendants keep their own identities and timestamps. The picker
excludes the entry itself and its descendants.

### One table

The logical model is one `entries` table:

| Value | Meaning |
| --- | --- |
| `id` | The entry's stable identity |
| `parentId` | Another entry's ID, or `null` for a top-level entry |
| `capturedAt` | When this entry was captured |
| Text body | The editable writing owned by this entry |

Children are selected by `parentId`; parents store no child-ID arrays. Both
views sort by `capturedAt` descending, with a stable ID tie-breaker. Text belongs
in the row's editable body; the conceptual model does not require a scalar
`text` field or a separate `description` field.

Parent references stay within this store. A move changes the moved entry's
`parentId`; returning it to the timeline sets that value to `null`. Descendant
rows do not need to change. The hierarchy must remain acyclic. Concurrent move
resolution and subtree deletion still need implementation rules before shipping.
A local ancestor check alone does not prove concurrent reparenting is safe.

### Relationship to Whispering

The separate capture app has its own store definition and namespace. Whispering
is the local desktop dictation workbench: most recordings stay there. Selected
text worth keeping can be promoted into the capture app. Whispering owns the
audio, transcript, and dictation activity. An explicit **Add to Capture** action creates
an independent text entry at the chosen destination. It does not copy audio or
require a source recording to remain available. Later capture edits belong to
the capture app; they do not rewrite Whispering's transcript. This handoff is
part of the intended workflow. Existing cursor or clipboard delivery can support
early prototypes, but does not replace explicit promotion of selected text.

Opening the capture app and typing directly follows the same entry model. The intended product
includes a web view where saved captures can be continued across devices.
Account onboarding and any device-only capture mode remain implementation
planning questions, not additional entry types.

This record establishes the capture product. It does not remove the implemented
Whispering Personal recording-copy workflow described by ADR-0428. Replacing that
workflow with a fully local recording product requires a bounded follow-up
decision covering existing saved recordings. No data removal is authorized here.

### Into Markdown

The person captures first, groups related thoughts later, then incorporates them
into their Markdown writing. The capture hierarchy helps prepare that material;
it does not require turning the capture app into another permanent notes editor.

After incorporating a capture, the person usually deletes it. Their Markdown
files then become the sole remaining home for that material. Deletion is their
choice: integration does not automatically delete, archive, or mark an entry as
processed. They can retain a capture for as long as it remains useful. The model
does not require a processed collection or a permanent link to the destination.

The person decides when integration is complete. A copied passage or successful
export alone cannot establish that all useful material, including children, has
been incorporated. Deleting from Capture does not delete or edit the resulting
Markdown files.

The handoff mechanism remains open: Markdown tools might read live captures or
receive an explicit export. Two-way file editing is not implied. Any assisted
handoff must distinguish successful transfer from the user's decision to remove
the source; a failed transfer must preserve the capture.

### Visual direction to explore

The initial direction is a quiet writing surface: a narrow reading column,
readable text, subdued timestamps, and a single accent for the active action.
Use spacing and light separators between entries rather than a grid of cards.
The composer stays near the top, above the newest entries. On a phone, opening
an entry uses the full screen; the breadcrumb and back action preserve context.

The hierarchy appears through navigation. The first design does not need a
permanently expanded tree, folder sidebar, dashboard, or separate page type.
An empty entry offers a place to write and a place to add a thought underneath.
The app is named **Capture**, with **Capture by Epicenter** for the full brand.
`capture.epicenter.so` is the intended address; hosting is not provisioned by
this record. Typography and color remain open.

## Consequences

Capture requires no advance organization. The same entry can start as one
sentence and become the entrance to a developing idea. Independent child
identities make opening any thought possible without interpreting indentation
inside a large document.

The timeline is a list of starting points, not a complete activity log. New work
deep in the hierarchy is visible there when opened; it does not surface at the
root automatically. Hierarchy also introduces real obligations around missing
parents, deletion, and concurrent moves.

Allowing later placement preserves capture-before-organization. Keeping the app
as an inbox also makes the Markdown handoff part of product completion, rather
than an optional export bolted onto a permanent notes app.

## Considered alternatives

- **One large body with nested bullets.** Easy to write, but a bullet cannot be
  opened as another instance of the same entry view without an additional
  identity model.
- **A flat timestamped feed.** Captures quickly, but cannot keep elaborations
  beneath the thought they develop.
- **A document per day.** Makes the date own the writing and introduces a
  different object at the root. Here, dates only group entries visually.
- **Automatic splitting of dictated ideas.** Makes recording segmentation decide
  the hierarchy. One stop can remain one capture regardless of its contents.
- **Choose a parent once and never move.** Simplifies concurrent hierarchy edits,
  but makes the person organize before capturing or recreate misplaced thoughts.
- **A permanent home for developed notes.** Changes the purpose of this app and
  competes with the Markdown workflow it is meant to feed.

## Path to implementation

Start with typed capture, persistence, the root timeline, and opening an entry
to add children. Verify the same interaction at three depths before adding
Whispering integration. Then prove cross-device text editing against the chosen
account lifecycle. Add the text handoff only after the destination works alone.
Include moving existing entries with their children, then establish the Markdown
handoff and the treatment of incorporated captures before calling the inbox complete.
Keep integration and user-requested deletion separate; no processed-state system
is required for this workflow.

Acceptance evidence should show that typing and dictation reach the intended
parent, each list remains newest first, child additions do not reorder ancestors,
and deleting a source recording does not affect the kept text. Recovery from a
failed save must preserve the text and avoid blindly creating duplicate entries.
Moves must preserve subtree identity and timestamps, including a move back to
the root. Concurrent moves must not strand entries in a cycle.
Integration must leave captures intact until the user chooses deletion. Deleting
a capture must leave the incorporated Markdown untouched.

Fuji's historical timestamped-entry design is precedent, not a dependency or a
request to restore its implementation. This record does not replace Honeycrisp.

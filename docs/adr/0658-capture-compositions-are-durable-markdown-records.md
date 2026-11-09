# 0658. Capture compositions are durable Markdown records from Add, not before

- **Status:** Accepted
- **Date:** 2026-10-21
- **Relates:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), Folder input ownership, and [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md), departure based on pending saves.

- **Current edit implementation:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) records the retained-source model implemented in `bd78bfb52b`. Editors and direct file/table commands share each path's publication lane; local writes are unconditional whole-file last-write-wins. Git synchronization keeps its merge rules. Earlier draft-merge and guarded-save descriptions below are historical.

## Context

Capture has two kinds of typing. Existing documents (a capture's text, a
draft's raw body, a file edited as text) are typed through the folder's edit of
the path: `createRowEdit(folder.tables.captures, stem)` or
`createTextEdit(folder.files, path)`, which autosave, retry and send on close.
Quick Add (New capture, and Add a thought) is text that is not in any file yet.

An earlier version of this record made New capture write an empty
`draft: true` file before accepting typing, so its writing autosaved, prompted
on departure, recovered after restart from a Drafts list, and Add promoted the
same file. Thought input stayed in page state: a store-level `formOf(stem)`
registry kept each capture's new thought and a staged per-thought Save/Cancel
edit across navigation.

A throwaway prototype then tested making thought input durable as well, with
real Folder storage in Bun subprocesses and in Chromium:

| Experiment | Observed |
| --- | --- |
| Abrupt exit, profile reopen | A saved draft file recovered exactly (spaces, CRLF, an open fence). Keystrokes not yet saved were lost anyway. |
| Applying a thought draft | A two-file operation. Interrupted after the capture save, the thought was in the capture once and the draft remained; retry refused, and resolving that was left to the person. |
| Capture deleted first | The thought draft remained, needing its own recovery surface. |
| One draft resumed in two tabs | The ordinary merge replaced one tab's text with the other's. Separate drafts kept both. |

A query listing draft files is derived data, not a registry, but the recovery
surface it feeds still costs. Persisting Quick Add text is not required now.

## Decision

**Quick Add text is component input until Add, and nothing is written before Add.**

| Text box | Owner | On Add |
| --- | --- | --- |
| New capture (`#new-capture`, `NewCapture.svelte` on the timeline) | `let text = $state('')` in the component | `captures.create(text)` |
| Add a thought (`#new-thought`, `CaptureDetail.svelte`) | `let newThought = $state('')` in the component | `actions.addThought(newThought)` |

Neither is registered, persisted, saved on close, warned about on departure,
or recovered after restart. Leaving the view clears it. Blank text is refused.
A refused or failed Add keeps the text; New capture is read-only while its Add
runs, so one Add writes one file.

**Add writes one finished capture.** `captures.create(text)` writes
`captures/<stem>.md` with `capturedAt` and `composeBody(text).body` in one
`folder.tables.captures.set(stem, null, …)`, then opens it focused on Add a
thought. `actions.addThought(text)` encodes the thought into the capture's row
edit, which saves it at once; the view clears its text only when the change is
taken.

**Existing documents bind directly to Folder edits.** The capture text and the
thought commands (`addThought`, `deleteThought`, `swapThoughts`) change the row
edit; Edit as text changes the text edit; both autosave, retry and send on
close as [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md)
says. There is no staged per-thought Save/Cancel form and no `formOf` registry.
A thought's Actions menu offers **Edit as text**, which opens the file's text
view with that thought's lines selected (`captureBody.locate(body)`), so
unfinished Markdown and CRLF lines are typed through the one text edit. A
command on positions names the list the view showed and is refused when it
changed.

**Existing `draft: true` files stay real documents.** The schema keeps
optional boolean `draft`. Drafts are listed apart on the timeline and open in
`TextDetail.svelte`, the same full-file Markdown editor used for repair and
thought editing. Its finish and discard controls follow the current parsed
frontmatter; editing frontmatter never replaces the mounted text editor.
`captures.finishDraft(stem)` saves that input, then, in one exclusive Folder
action, writes `composeBody(raw).body`, removes `draft` and sets `capturedAt`
in the same file; a file already finished succeeds without composing twice.
Discard draft is the confirmed delete. Capture creates no new draft files.

## Consequences

Typing in New capture or Add a thought performs zero Folder writes and never
holds a reload or a window close. A reload, crash, forced close, or leaving the
view loses that text, of any length, with no warning. No empty draft files
accumulate, and nothing new needs a Drafts recovery surface.

Draft files an earlier version saved keep their exact raw bodies, their Drafts
listing, their autosave and departure prompts, and same-file finishing, so the
`draft` field and the finish action remain while such files may exist. The
separate saved-draft composer is removed; its textarea, submission form,
newline conversion, and save-recovery UI are owned by the full-file editor. A
nonboolean `draft` value still needs repair as text. Draft users now see their
frontmatter too. Removing `draft: true` by hand skips composition and the date
update; Add remains the supported finish action.

Editing a thought is editing the file's text: its merge with another tab's
change follows the text edit's ordinary rules rather than a per-thought
conflict check.

## Considered alternatives

- **A `draft: true` file at New capture** (this record's earlier version):
  recovers writing after restart, but writes before Add, prompts on departure
  for every unsaved keystroke, and leaves empty drafts to discard.
- **Durable thought drafts:** two-file Apply, orphan recovery, and overwrites
  when one draft is resumed in two tabs, as the prototype showed.
- **A staged thought edit form:** holds proposed wording until Save. This is
  valid for explicit submission, but the chosen direct editing interaction
  removes that Save/Cancel step. Binding each keystroke through `captureBody`
  would not hold unfinished text, because thought normalization strips blank
  edge lines.
- **A departure warning for Quick Add text:** possible later; it would not
  cover a crash.

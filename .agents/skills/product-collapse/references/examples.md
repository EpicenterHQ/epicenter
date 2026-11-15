# Examples that teach the judgment

These examples apply dialectic's intent, greenfield vision, and working backward
to product choices. The alternatives make particular differences visible; they
are not a required menu or sequence of collapse levels.

The conversations below are invented illustrations of the workflow, not measured
runs or new product decisions. The Tasks case describes a previously chosen
behavior. Transfer each question to the current job and verify machinery claims
against its code.

## Configurability: could the product resolve this choice once?

A personal activity tracker has a report builder with selectable columns,
grouping, order, layout, and saved views. The person says setup feels heavy.
The agent offers an intent, and the person recognizes it:

> See the patterns in my activity each week without assembling a report.

The agent then compares two experiences:

| Experience | Assumption tested | Cost and possible removal |
| --- | --- | --- |
| Open a useful default report, with the builder available when needed. | Must setup come before seeing anything? | Less setup; custom views remain. The builder and its configuration machinery remain too. |
| Open one fixed weekly review. | Are custom layouts part of the job? | Lose custom views. Saved layout schemas, the editor, preview paths, and option-combination rules become removal candidates. |

The agent recommends the fixed review if the person asks the same questions
each week. If exploring the data is the job, the builder can earn its place.

The person responds: "Layout doesn't matter, but I need to compare different
date ranges." This refines the experience: one review with a date-range choice.
It does not require selecting an option wholesale or restoring the builder.

Work backward: one report path, the necessary date input, and the underlying
records and facts such as totals and trends. Verify which configuration code
has no remaining callers. A default alone reduces setup; the narrower behavior
can remove an implementation responsibility. Two possibilities were enough to
expose this choice.

## Books: does unfinished input need another owner?

Suppose an Add book form has title and URL fields, a reactive draft, and browser
storage that restores unfinished entries after navigation. Nothing reads the
typing for a preview, search, or dependent control. The shared intent is:

> Keep books I want to return to, with enough information to recognize and open them.

The agent shows three experiences that question different assumptions:

| Experience | What could disappear | Cost or remaining obligation |
| --- | --- | --- |
| Keep the form and restoration; let native controls hold the values. | Reactive copies and synchronization with no live readers. | No intended capability loss. Persistence still needs an owner and event handling. |
| Fill out the form and press Add; leaving abandons the unfinished entry. | Stored drafts, restoration, draft keys, and cleanup. | Unsubmitted typing no longer survives navigation. |
| Add the URL immediately; supply a title afterward when useful. | The requirement to complete all details before creating an entry. | Incomplete entries and later organizing work remain. Unrecognizable URLs could make this worse. |

The agent recommends the second if restoration is unnecessary and recognizable
entries matter. The third changes when an entry counts as complete; it needs
judgment about that workflow, not just enthusiasm for fewer controls.

The person responds: "I don't need drafts, but I do want a recognizable title
before adding." That settles the behavior. Work backward to native controls
and one ordinary submission:

```text
on Submit(event):
  prevent default
  capture values from event.currentTarget synchronously
  validate the captured values
  disable editing while saving
  save using those values
  on success: reset the form
  on failure: show the error and leave input available
  enable editing
```

The browser still holds unfinished text. The submitted operation owns its
captured values. Neither a reactive mirror nor navigation persistence has a
remaining job here. A live preview would justify reactive input; composing on
one device and finishing on another could justify a durable draft.

## Modes: does the person need both experiences?

An app with live and demo modes may have a source interface, separate cache
keys, simulated writes, mode transitions, and explanatory UI. If the person
only uses live data, removing the installed demo experience could delete that
parallel path. They lose in-app rehearsal and fictional onboarding data.
Keep isolated development fixtures; they need not create a product mode.

Keep demo mode when rehearsing without external effects is a valuable job.
The relevant distinction is which experience someone needs, rather than how
many implementations exist. Trace the actual mode before claiming a deletion.

## Tasks: does unfinished editing need a separate life?

The chosen Tasks behavior treats leaving the notes field as submitting its
current value. Previously, notes had an explicit Save step and a per-task
`sessionStorage` draft. The draft let someone leave or reload and return to
unfinished edits without changing the task file.

Once blur means submission, the control can own text until blur, and the normal
mutation can own the submitted operation. The tab-local draft store, restoration,
per-task keys, cleanup, Save/Discard controls, and draft-specific leave warning
disappear. This was the chosen tradeoff; an invocation should carry it forward
unless new evidence calls its premise into question.

The person loses the ability to stage notes indefinitely, discard that batch,
or recover text that was never submitted after reload. Blur is not guaranteed
during navigation or teardown, and dispatch does not guarantee completion.
The choice accepts those limits. The implementation still needs correct cache
updates and visible failure with access to the submitted text for retry.

This does not establish that all notes should save on blur. Returning to a long
composition may be the job, and a durable draft can be its simplest complete owner.

## Forms: which values make one decision?

A trip form can contain departure bounds, duration bounds, and a return choice.
Each intermediate edit need not describe a valid trip. Submit accepts the
jointly valid set as one action; Cancel can discard the unfinished set.

An independently valid field is a candidate for separate submission, but the
person may still want to stage, review, or cancel edits together. Converting
this form to field-by-field writes could create partial validity rules and
recovery machinery. Fewer Save buttons would then create more complexity.

Choose when input becomes accepted before choosing its owner. Focus normally
begins editing; blur, change, typing, and Submit can express different policies.
Events implement a meaning chosen for the job. Native controls can hold values
read only at submission; live previews or dependent controls need live readers.

For settled input behavior, use
[Svelte input ownership](../../svelte/references/input-ownership.md) to choose
native controls, reactive drafts, and their lifetimes, and
[query-layer](../../query-layer/SKILL.md) for submission and mutation lifecycle.

## Dictation: can composition finish before delivery begins?

Consider a proposed change from "Stop & send, then advance" to "Stop transcribes
into the ordinary composer; Send delivers the reviewed text." This is a design
example, not a claim that the app has made the change.

The combined gesture promises to carry a recording and any typed prefix through
transcription, delivery, and navigation. Separating the actions lets dictation
produce ordinary editable input. Sending then uses the same path as typed text.
Voice-specific delivery, prefix handoff, retry branches, and navigation
coordination become removal candidates; trace their actual callers before
claiming they all disappear.

The person gains a review point and loses one-step, eyes-free reply and advance.
If that hands-free workflow is the product's purpose, keep the combined action.
Otherwise, an extra gesture may remove a much larger coordination burden.

Keep the recording until successful transcription has produced text owned by
the composer. Keep ordinary send-outcome recovery too: a failed acknowledgment
does not prove the recipient received nothing. Separating the stages relocates
responsibility to existing owners; it does not erase failures within a stage.

## Recovery: what would be unknowable or lost without this record?

Name the information recovery preserves, its owner, and how long it is needed.
Distinguish replaceable UI bookkeeping from unfinished work, the only copy of
input, a reviewed decision, and an uncertain external outcome. A pending mutation
does not replace those facts. Earlier submission also does not prove that a
write completed or that another writer cannot conflict.

Recovery earns its place when it preserves independent information:

- A saved message draft lets someone compose on one device and finish on
  another. It is part of the workflow, rather than a duplicate cache of a
  submitted record.
- A recording may be the only copy of dictated words after transcription
  fails. Removing it cannot be repaired by retrying with an empty input.
- A message may have been delivered when its acknowledgment is lost. Retain
  enough evidence to reconcile or ask the person to check before resending;
  generic error state cannot establish whether the external effect happened.
- A reviewed proposal snapshot identifies exactly what someone approved while
  an agent can still change the underlying draft. Removing it can make approval
  authorize different content.

These teach preservation of facts, work, and decisions. Simplify their owners
and presentation where possible. Remove them only after a product decision or
another proven owner makes that information unnecessary, rather than because
they resemble the draft machinery removed from Tasks.

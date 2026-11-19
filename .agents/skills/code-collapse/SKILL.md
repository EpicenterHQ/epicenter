---
name: code-collapse
description: Find a simpler design behind code complexity, carry it through its callers, and verify the result. Use when asked for a collapse pass, a refactoring or simplification pass, another pass, "simplify this", "conceptually collapse this", to clean up code, or to hunt for indirection, dead abstractions, and redundant subsystems. Also use for a periodic code audit or smell search in TypeScript and Rust, and for the one-sentence test: stating in one sentence what a surface or abstraction actually does, to find orphaned surfaces, duplicate verbs, and inert abstractions. Answer a plain code-comprehension question directly instead.
metadata:
  author: epicenter
  version: '2.0'
---

# Code collapse

A code collapse, or collapse pass, looks for a simpler way for the system
to do its job.
Question the current concepts and promises as well as their implementation.

Try the plainest articulation of the design. Follow “it’s just plain X”
through a real use and see what work disappears.

Look for the choices that make the code do extra work. Several helpers,
checks, caches, and exceptions may all exist because of one earlier
decision. Ask what would let those pieces disappear together, then carry
the better design through the code that uses it.

A common case is a running thing that has to stay in step with a change.
Keeping it alive while a setting changes takes a lot of code. Rebuilding it
takes almost none, because startup already knows how.

- A server with hot reloading. Build it again and restart it, and the
  reload machinery is never needed.
- A database connection when a key changes. Instead of killing it and
  rebinding while every `db` reference keeps working, reload the page and
  let startup make a new one.

Each trades a brief interruption, and sometimes unsaved work, for deleting
everything that kept the old thing in step. When that changes what the
person experiences, such as an editor window that can no longer switch
folders, develop the choice with them in
[product-collapse](../product-collapse/SKILL.md) unless it is already
settled.

## Understand the work

Start from what the person or caller needs to accomplish. Read the
relevant code and the code that uses it. Build on what the user has
already decided. Ask when an unresolved purpose or tradeoff would
change the work.

Follow connected evidence when it points to a shared cause. Explain the
connection before editing beyond the starting area.

## Find what makes the work necessary

Look for information kept in several places, repeated decisions,
forwarding layers, and rules that need another exception for each new
case. Include the fixes already made, including your own. A workaround
may reveal a better design even before the same problem recurs.

Searches for maps, registries, flags, caches, retries, adapters, and
compatibility paths can help you find these places. Use the
[smell searches](references/smell-searches.md) for TypeScript and Rust when
one fits. Treat matches as clues, not instructions to delete something.

Use [rethink](../rethink/SKILL.md) to consider how you would build this
today. Look beyond making the existing pieces tidier:

- Could readers ask the thing that already knows? A Map that copies
  connections a pool already tracks may disappear along with its updates.
- Could one part do the whole job instead of several parts keeping each
  other informed?
- Could choosing something once remove repeated choices and checks?
- Could related operations belong together so callers stop passing the
  same information through several layers?
- Could a different workflow make an entire subsystem unnecessary?

Develop the alternative far enough to show how it works. Use realistic
caller code, an interaction, or a data flow. Try it on the awkward cases
as well as the ordinary ones. Use the
[concept inventory](references/concept-inventory.md) when showing the
current and proposed parts would help someone judge the change.

If the alternative keeps needing exceptions, reconsider how you have
divided the work. Keep the current design when it handles real needs
more simply than the replacement.

## Keep what still has a job

Before removing state, find out what it remembers and who needs it.
Something that looks like a copy may preserve a different fact:
unfinished input, a submitted version, a choice someone made, or an
action whose outcome is still uncertain.

Establish that the replacement has the information whenever it is
needed. Before removing a check, understand what it protects and whether
the information it uses is still current.

Keep a boundary when it names non-obvious work, enforces a shared rule,
owns a lifecycle, isolates unsafe input, or makes a long phase
understandable. Caller count alone does not decide.

Judge the complete result. Fewer lines alone are insufficient. Deleting
a file does not simplify the system if its job is now spread across
callers. Name what becomes easier to understand or maintain, and account
for any new work the replacement introduces.

## Say it in one sentence

To check whether something earns its place, write one plain sentence about
what it does, in your reply where the reader can see it. Name the things
and the verbs. If you can't finish the sentence without contradicting
yourself, the design isn't clear yet. Say so before going on.

**For a set of commands, endpoints, or options,** check each one against the
sentence. If dropping one leaves a sentence that still describes something
useful, see asymmetric wins in [product-collapse](../product-collapse/SKILL.md).

For example, a notification API has `send`, `schedule`, `batch`, `digest`,
`preferences`, `channels.register`, and `history`. "A notification system"
says nothing. "Send messages to users across channels" ignores
`preferences` and `history`. "Deliver a message to a user on their
preferred channel, honoring quiet hours, and remember we sent it" covers
five of them. `schedule`, `batch`, and `digest` don't fit: they are a
separate product.

**For a wrapper, flag, or helper,** describe what it does three times:

```txt
1. From the code, ignoring the name and docs:
   "Looks up by id, counts opens and closes, and destroys the object
   after an idle timeout."
2. With the settings actually in use (gcTime: Infinity):
   "Looks up by id. Nothing is ever destroyed." The counting does nothing.
3. For what the caller needs: the caller has one id and one lifetime, so
   the lookup does nothing either. The wrapper adds nothing. Delete it.
```

If the honest sentence is "it does nothing," delete it.

## Carry the change through

Establish the starting state so your changes remain distinguishable from
existing edits.

An implementation pass authorizes routine simplifications within its
scope. Make those changes without asking about each one. Give short
updates explaining meaningful findings and changes in direction.

When a simpler design would change a product promise, use
[product-collapse](../product-collapse/SKILL.md) to develop the experience
with the user; its asymmetric wins section covers judging whether giving
up one small promise would remove much larger complexity.

Carry settled decisions forward. Bring back consequential choices that
exceed existing authorization, including changes to stored formats or
externally consumed contracts. Do not ask again merely because files
merge or an internal signature changes.

Implement the connected change through its affected callers. Moving a
guarantee must not leave an old path that silently loses it. Use
[clean breaks](../rethink/references/clean-breaks.md) to retire superseded
paths. Keep temporary compatibility only for a named consumer or
migration, with a retirement condition.

Preserve stored data, unfinished input, unrelated work, and real consumer
contracts. Applied migrations are durable history. Read
[durable contracts](references/durable-contracts.md) when changing storage,
sync, auth, or public contracts.

Verify external library behavior against official documentation or
installed types when correctness depends on it. Read
[library refusal](references/library-refusal.md) before reshaping or
reimplementing a library's public surface.

Use [refactoring methods](references/refactoring-methods.md) for local
techniques and leftover-reference cleanup. Remove obsolete exports,
comments, tests, and documentation with the replacement. Preserve
coverage for behavior that remains.

Run checks appropriate to the changed behavior. Resolve failures or
report them with evidence; do not blame the baseline without checking.
Fix regressions introduced by the pass before moving to unrelated work.
Review the cumulative result with
[post-implementation-review](../post-implementation-review/SKILL.md).

If a change no longer earns its place when reread, undo only that change
while preserving unrelated and unsaved work.

## Look again, then stop

After a fix works, consider the whole again. Knowing what you know now,
would you choose these parts and this division of work?

“Another pass” starts from that reassessment. The user's settled intent
carries forward; earlier implementation choices remain open to question.
Use previous findings and rejected ideas to choose new places to look.
Revisit a rejected idea when new evidence changes its justification.

Continue through the relevant subsystem while convincing opportunities
remain. A few unproductive files are a reason to change the search, not
an automatic stopping rule.

Stop when further investigation yields no convincing simplification,
the remaining work needs a consequential decision, or an explicit budget
is reached. Do not manufacture changes to make a pass look productive.

Report what caused the extra work, what replaced it, what disappeared,
what was verified, and any remaining decisions. Use
[report guidance](references/report-format.md) for a longer campaign.

---
name: code-collapse
description: Find a simpler design behind code complexity, carry it through its callers, and verify the result. Use when asked for a collapse pass, a refactoring or simplification pass, another pass, "simplify this", "conceptually collapse this", to clean up code, or to hunt for indirection, dead abstractions, and redundant subsystems. Also use for a periodic code audit or smell search in TypeScript and Rust, and for the one-sentence test: stating in one sentence what a surface or abstraction actually does, to find orphaned surfaces, duplicate verbs, and inert abstractions. Answer a plain code-comprehension question directly instead.
metadata:
  author: epicenter
  version: '2.0'
---

# Code collapse

A code collapse, or collapse pass, looks for a simpler way for the system
to do its job. Ask how you would build this today, not how to tidy what is
there.

Try the plainest articulation of the design. Follow “it’s just plain X”
through a real use and see what work disappears.

Several helpers, checks, caches, and exceptions may all exist because of
one earlier decision. Ask what would let those pieces disappear together,
then carry the better design through the code that uses it.

## Inline everything and read it fresh

Mentally inline every helper, wrapper, file, and extracted function back
into its call sites. Do the same for components, props, and any other layer
of indirection. Read the result as if seeing it for the first time, then
ask:

- **Dead paths.** Are there methods or configuration hooks that nothing
  calls? A reconfiguration method is dead when the consumer already
  recreates the whole object on change.
- **Stale boundaries.** Did a module split, wrapper, or extracted type make
  sense at an earlier stage but no longer earn its indirection, given what
  the code does now?
- **Names.** Do the names say what the code does now, or what it used to
  do? Check file names too: does `foo-manager.ts` still manage anything, or
  is it a passthrough?
- **File organization.** If you could rename, move, merge, or split files,
  what would you change? Show the proposed tree beside the current one.
- **Copies.** Could readers ask the thing that already knows? A Map that
  copies connections a pool already tracks can disappear along with its
  updates.
- **Repeated choices.** Could choosing something once remove the choices
  and checks that follow it everywhere?

Say what you would change and what you would leave alone, with your
reasoning, before editing a boundary, a name, or a file. Local cleanups can
proceed.

The [smell searches](references/smell-searches.md) find candidates in
TypeScript and Rust. Use [rethink](../rethink/SKILL.md) when the question
is the whole design.

## Restart instead of keeping it in sync

A common case is a running thing that has to stay in step with a change.
Keeping it alive while a setting changes takes a lot of code. Rebuilding it
takes almost none, because startup already knows how.

- A server with hot reloading. Build it again and restart it, and the
  reload machinery is never needed.
- A database connection when a key changes. Instead of killing it and
  rebinding while every `db` reference keeps working, reload the page and
  let startup make a new one.

Restart only where shutdown can finish pending work and startup can recover
what must survive.

## Say it in one sentence

To check whether something earns its place, write one plain sentence about
what it does, in your reply where the reader can see it. Name the things
and the verbs. If you can't finish the sentence without contradicting
yourself, the design isn't clear yet. Say so before going on.

For a wrapper, flag, or helper, describe what it does three times:

```txt
1. From the code, ignoring the name and docs:
   "Looks up by id, counts opens and closes, and destroys the object
   after an idle timeout."
2. With the settings actually in use (gcTime: Infinity):
   "Looks up by id. Nothing is ever destroyed." The counting does nothing.
3. For what the caller needs: the caller has one id and one lifetime, so
   the lookup does nothing either. The wrapper adds nothing for this caller.
```

If the honest sentence is "it does nothing," it can go.

For a set of commands, endpoints, or options, check each one against the
sentence. If dropping one leaves a sentence that still describes something
useful, see asymmetric wins in [product-collapse](../product-collapse/SKILL.md).

## Before you delete

Find out what it remembers and who else uses it. Something that looks like
a copy may hold a different fact: unfinished input, a submitted version, a
choice someone made. A search with no callers does not prove code is
unused: string-keyed access, Tauri command names, and Svelte templates
escape grep. Deleting a file does not simplify the system if its job is now
spread across callers.

Read [durable contracts](references/durable-contracts.md) before changing
storage, sync, auth, or a public contract.

## Carry it through

Carry the change through every caller. Moving a guarantee must not leave an
old path that silently loses it. Keep temporary compatibility only for a
named consumer or migration, with a retirement condition; see
[clean breaks](../rethink/references/clean-breaks.md). Remove obsolete
exports, comments, tests, and documentation with the replacement. Commit
behavior-preserving cleanup separately from behavior changes.

When a simpler design would change what the person experiences, develop it
with them in [product-collapse](../product-collapse/SKILL.md).

## Reread what you touched

After making changes, reread every file you touched. For each one:

1. **Inline test.** Mentally inline every function call and helper. Looking
   at the raw call sites, would you draw the same boundaries, or are some
   wrappers and modules indirection that doesn't earn its keep?
2. **Smell check.** Any dead code, redundant operations (a `mkdir` on every
   write when the directories exist), unnecessary type casts, or exported
   types with no consumers?
3. **Invariant audit.** Does the code assume something the current design
   no longer guarantees, or still check something that is now handled
   earlier (a per-write safety check that setup already covers)?
4. **API shape.** If you designed the public API from scratch with what you
   know now, would the signatures, config types, or module boundaries look
   different?

Flag what you find. Don't fix silently: say what is wrong and why before
changing it.

"Another pass" starts from this reread. Keep going while convincing
opportunities remain. Stop when there are none, when the remaining work
needs a decision from the person, or when a budget is reached. Do not
manufacture changes to make a pass look productive.

Report what caused the extra work, what replaced it, what disappeared, and
what was verified.

## References

- [Refactoring methods](references/refactoring-methods.md): local techniques
  and leftover-reference cleanup.
- [Concept inventory](references/concept-inventory.md): showing current and
  proposed parts side by side.
- [Library refusal](references/library-refusal.md): before reshaping or
  reimplementing a library's public surface.
- [Report format](references/report-format.md): for a longer campaign.
- [post-implementation-review](../post-implementation-review/SKILL.md): the
  review of the cumulative result.

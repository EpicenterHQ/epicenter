---
name: code-collapse
description: Find a simpler design by setting aside existing choices and building from scratch around what callers need. Use when asked for a collapse pass, a refactoring or simplification pass, another pass over a simplification, "simplify this", a code audit or smell search, or to judge what a technical surface actually does by describing it in one sentence. Answer a plain code-comprehension question directly.
metadata:
  author: epicenter
  version: '2.0'
---

# Code collapse

What would you build if you inherited none of the current design? You can set
aside every design decision in the first sketch. Build up from the job the code
has to do and see which pieces that job actually calls for.

## Set the design aside and rebuild

When several choices make each other look necessary, set them aside together.
Start with a real caller and sketch the shortest flow that does its job.
Walk that design through the other cases it has to handle, including failure
and cleanup. Add a piece when you can name the case that needs it. Ask whether
an earlier choice could establish a rule once and make later checks unnecessary.

Could readers ask the thing that already knows?

Take a connection pool, a map that mirrors its connections, and a callback
that keeps the map current. Set all three aside. The caller needs to acquire a
connection, use it, and release it. If callers need to reuse connections, a
single pool can own that work. Callers that need to look up a connection can
ask the pool directly. Walk through shutdown next. If shutdown has to wait
for work to finish, give draining an owner in the new design.

When something has to stay in sync, consider whether startup can build it
again. Restart only where shutdown can finish pending work and startup can
recover what must survive.

For a larger design, use the [concept inventory](references/concept-inventory.md)
to track what responsibilities disappear or move. Use
[rethink](../rethink/SKILL.md) when the question is the whole design and
[product-collapse](../product-collapse/SKILL.md) when an omission changes
what someone can do or expect.

## Use the current code as evidence

When you need to understand what a particular piece does, sketch the design
without it. Walk a caller through what breaks, who relies on it, and whether
the new design can do that work somewhere simpler.

Mentally inline helpers, wrappers, components, and props into a real call
path. Seeing the work together makes it easier to tell which boundaries
enforce a rule, own a lifetime, or name a meaningful step. Try describing the
result as “it’s just plain X” and follow that description through a real use.

Use [smell searches](references/smell-searches.md) to find candidates in
TypeScript and Rust, and [refactoring methods](references/refactoring-methods.md)
for techniques that fit the candidate.

## Say it in one sentence

Write one plain sentence about what the piece does. Name the things and the
verbs, and show the sentence when the user asks for the test. For a wrapper,
flag, or helper, ask how the sentence changes as you move from what the code
supports to what callers use.

1. **From the code.** It looks up an object by ID, counts opens and closes,
   and disposes of the object after an idle timeout.
2. **With the settings in use.** It looks up the object and counts opens and
   closes. The timeout is disabled, and only the timeout uses the count.
3. **With the callers in view.** The caller uses one object for the whole
   lifetime, so it can hold the object directly.

Use the difference between the sentences to choose what to try omitting.
For a set of commands, endpoints, or options, check which ones the sentence
needs to describe a useful job.

## Carry it through

Before deleting anything, trace actual callers, including string-keyed
references, and check which facts and guarantees the code preserves.
Unfinished input and a submitted version can look like copies. Find the owner
of any work the new design still needs. Read
[durable contracts](references/durable-contracts.md) before changing storage,
sync, auth, or a public contract. Check [library refusal](references/library-refusal.md)
before reshaping or reimplementing a library's public surface.

Explain consequential boundary changes before editing. For a review-only
request, return the findings and proposed changes. When authorized to edit,
carry the change through the affected callers and remove superseded exports,
comments, tests, and docs. Commit behavior-preserving cleanup separately from
behavior changes. If an existing consumer needs a temporary compatibility
path, name the consumer and when the path can go. See
[clean breaks](../rethink/references/clean-breaks.md) for migration decisions.

Verify behavior through the affected callers. Reread the changed paths with
the new boundaries in place and ask what could go now. Continue while the
evidence supports another simplification. Stop when the remaining parts earn
their place or further changes need a decision from the user.

Report why the extra work existed, what disappeared, where necessary behavior
lives now, and what you verified. For a longer effort, see
[collapse pass reports](references/report-format.md). Finish a standalone pass
with substantial changes using [post-implementation-review](../post-implementation-review/SKILL.md).

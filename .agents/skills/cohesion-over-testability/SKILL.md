---
name: cohesion-over-testability
description: Collapse test-shaped production boundaries while preserving behavior and coverage. Use when a helper, wrapper, injected dependency, or export exists mainly to let a unit test reach internals.
metadata:
  author: epicenter
  version: '1.0'
---

# Cohesion Over Testability

A unit test is supposed to verify production code. Sometimes the
relationship inverts: the test reaches for an invariant the natural API
won't surface, so the production code is split into a "pure inner" and a
"thin outer", with the inner exported solely so the test can call it.
The split is invisible from the outside (one production consumer, no
reuse), but it's permanent shape. The test suite became an architecture
client.

That's the smell. The cure is to glue the pieces back into one function
and find a different way to pay the regression-coverage bill: integration
tests through the real boundary, type-level invariants, or deletion of a
test that was insuring trivial branch logic at high seam cost.

Related skills: [rethink](../rethink/SKILL.md) develops the replacement when a
candidate reveals a flawed surrounding design; [refactoring](../refactoring/SKILL.md)
owns caller counting and inlining mechanics; [testing](../testing/SKILL.md)
for what the post-collapse tests should look like;
[one-sentence-test](../one-sentence-test/SKILL.md) to confirm the inner
function has no independent product sentence.

## References

Load on demand based on the task:

- For **running a systematic audit across the codebase** (audit greps,
  triage buckets, commit hygiene, anti-patterns, walking away), read
  [references/sweep-procedure.md](references/sweep-procedure.md).

## The Signal vs The Reason

Three things often co-occur and get confused:

1. **The split**: production code is in two pieces.
2. **The seam**: the inner takes injected dependencies.
3. **The test**: a unit test calls the inner with fakes.

The seam may be load-bearing (sockets, signals, filesystem, network,
policy callbacks) OR ceremonial. Don't classify the seam first; classify
the split. Ask: **if the test didn't exist, would the inner function
exist as a separate piece?** If no, the split is testability theater
regardless of what the seam carries.

A useful corollary: if the outer's body is "call the inner, then
format the result", the outer adds nothing. The inner IS the outer in
disguise. Two names for one thing.

## The Procedure

1. **Count production callers.** `grep` for the inner function's name
   across the workspace, excluding the test file. If the count is one,
   continue. If it's two or more, the split may be earning its keep
   through reuse; stop and reassess.

2. **Read the outer.** If its body is a call to the inner plus
   formatting / I/O / wiring, the inner can be inlined.

3. **Read the test.** For each `expect()`, ask what it observes. If the
   observation is internal state visible only through the seam, the
   test was driving the split.

4. **Count LOC.** Test LOC vs SUT LOC. If the test is the largest
   artifact and its only consumer is itself, the cost-benefit is
   inverted.

5. **Inline.** Move the inner's body into the outer. Drop the export.
   Drop the seam.

6. **Pay the coverage bill differently.** Pick one:
   - **Integration test** through the natural boundary (CLI invocation,
     HTTP request, Svelte mount). Heavier setup, more realistic
     coverage.
   - **Type-level invariant.** If the test was checking "we always call
     `dispose()` when X", encode it with `T extends Disposable` or a
     branded return type.
   - **Delete the test.** If the branch logic is small (under ~10
     lines), trivially type-checked, and exercised on every product
     use, the test was buying insurance you didn't need. Delete it.
     Note in the commit why the regression risk is acceptable.

## When NOT to Inline

Don't inline when any of these hold:

- The inner has multiple real production consumers. The seam earns its
  stability tax through reuse.
- The inner's body is genuinely complex enough to be its own concept
  with its own product sentence. The split exists for cohesion, not
  for the test.
- The inner crosses a real package boundary (different runtime,
  different process, different deploy unit). Tests aside, the split is
  structural.
- The injected dependency is **policy** (a decision the caller owns:
  what to do on error, how to reload, when to retry). Policy callbacks
  earn the seam.
- Inlining would force the outer to grow past readable size (the
  natural cap is around 60-80 LOC; past that, splitting for cohesion
  is fine — but the split should serve a product sentence, not a
  test).

The question to ask: **without the test, would I have written this as
two pieces?** If yes, keep the split. If no, inline.

## Worked Example: session lifecycle

From `@epicenter/svelte`, commit `d5b61aed8`:

```
session-lifecycle.ts        47 LOC  (the "pure" inner)
session-lifecycle.test.ts  187 LOC  (the only direct caller)
session.svelte.ts           69 LOC  (the production "outer")
```

The inner took `getPayload` / `setPayload` so the test could supply its
own slot. The outer was a `$state` declaration plus a forwarding call.
The inner had zero production callers other than the outer; the test
had zero production functionality to verify other than what the outer
already did end-to-end.

Inline: drop the inner file, let `$state` live in the outer, delete the
unit test. Net: minus 265 LOC, three files to one, two injection points
to zero. The four invariants the test was asserting are now visible in
~6 lines of branch logic, type-enforced by `T extends Disposable`, and
exercised on every app boot.

Article: [Don't Split for the Test](../../../docs/articles/20260513T120000-dont-split-for-the-test.md).

## Common Forms of the Smell

**Form 1: paired getter/setter.** Helper takes `getX` and `setX` for
one slot. Production caller closes over a `let` and passes both
closures. Inline the slot into the caller; let the rune or class field
own it.

**Form 2: optional `deps` for fake substitution.** Function has an
optional `deps` parameter whose default is the real implementation and
whose only non-default value is supplied by the test. Inline the
function into its sole production caller; drop the `deps` type.

**Form 3: pure-inner + thin-outer.** A `run*()` function does the work;
a command handler / route handler / component is a one-line wrapper
calling it. The outer adds no logic. Inline the inner into the outer.

**Form 4: state-only mock injection.** A factory takes a `clock`,
`now`, `random`, `idGenerator` parameter so tests can supply
deterministic values. This is sometimes legitimate (deterministic IDs
across distributed systems) and sometimes ceremony. Ask: does any
production caller pass a non-default value? If no, it's Form 2.

**Form 5: re-exported internal for tests.** A module exports a private
helper "for testing." If the export comment says `@internal` or
`/** @testonly */`, the test owns the export. Inline the helper into
its sole user; remove the export.

## Audit Sweep

For sweeping a codebase, look for two signals together:

```sh
# Functions exported next to a test file with high test:SUT ratio.
for t in $(find packages apps -name '*.test.ts' -not -path '*/node_modules/*'); do
    s="${t%.test.ts}.ts"
    [ -f "$s" ] || continue
    tl=$(wc -l < "$t" | tr -d ' ')
    sl=$(wc -l < "$s" | tr -d ' ')
    [ "$sl" -lt 1 ] && continue
    ratio=$(( tl * 10 / sl ))
    [ "$ratio" -ge 25 ] && echo "$t ($tl) vs $s ($sl) ratio=${ratio}/10"
done

# Functions exported with optional `deps` / `overrides` parameters.
grep -rEn 'export (async )?function [a-zA-Z]+\([^)]*\bdeps\??: ' packages/ apps/ --include='*.ts'
grep -rEn 'export (async )?function [a-zA-Z]+\([^)]*\boverrides\??: ' packages/ apps/ --include='*.ts'

# Paired getter/setter parameters.
grep -rEn 'get[A-Z][a-zA-Z]+\??:.*\bset[A-Z][a-zA-Z]+\??:' packages/ apps/ --include='*.ts'
```

Each match is a candidate, not a verdict. Run the six-step procedure
on each. The intersection of "high LOC ratio" and "exported function
with `deps` parameter" is the hottest place to look.

# Sweep Procedure

How to systematically audit a codebase for test-shaped splits and collapse
them safely. This is the operational playbook for the
[cohesion-over-testability](../SKILL.md) skill.

The `up`, `down`, and `ps` examples below are historical decisions from the folder-sync CLI. They illustrate how similar-looking test seams earned different verdicts. Commits `9434030a7` and `50a9b0c61` preserve the two removals.

## When to run a sweep

- **After a big merge** that landed a stack of Wave-N unit tests. New
  fossils are easiest to spot before they ossify into "how we always do
  it."
- **On quiet days**, never mid-feature. Sweeping creates churn; don't
  layer it on top of in-flight work.
- **Monthly**, as a recurring discipline. Set a calendar reminder; the
  smell accumulates faster than you'd think.
- **NOT** when a release is imminent, when CI is red, or when someone
  else has open PRs touching the files you'd sweep.

## Step 1: Run the audit greps

Three signals, run independently. Each returns candidates, not verdicts.

```sh
# Test files significantly larger than the SUT next door.
for t in $(find packages apps -name '*.test.ts' -not -path '*/node_modules/*'); do
    s="${t%.test.ts}.ts"
    [ -f "$s" ] || continue
    tl=$(wc -l < "$t" | tr -d ' ')
    sl=$(wc -l < "$s" | tr -d ' ')
    [ "$sl" -lt 1 ] && continue
    ratio=$(( tl * 10 / sl ))
    [ "$ratio" -ge 25 ] && echo "$t ($tl) vs $s ($sl) ratio=${ratio}/10"
done

# Exported functions with optional `deps` / `overrides` / `injected`.
grep -rEn 'export (async )?function [a-zA-Z]+\([^)]*\b(deps|overrides|injected)\??: ' \
    packages/ apps/ --include='*.ts'

# Paired getter/setter parameters.
grep -rEn '\bget[A-Z][a-zA-Z]+\??:.*\bset[A-Z][a-zA-Z]+\??:' \
    packages/ apps/ --include='*.ts'
```

The intersection of "high LOC ratio" AND "exported function with `deps`
parameter" is the hottest. Start there.

## Step 2: Triage each match into a confidence bucket

For each candidate, answer three questions before reading code:

1. Does the inner function have a product sentence of its own, or is it
   "a slice of the outer"?
2. Is the outer's body "call the inner plus format," or does it do
   substantial orchestration of its own?
3. Does the `deps` parameter (if any) carry policy, cross a runtime
   boundary, or merely substitute fakes?

Bucket the candidate:

| Bucket | Inner sentence | Outer body | Deps |
|---|---|---|---|
| **HIGH** (collapse now) | Slice of outer | Call + format | Substitutes fakes only |
| **MEDIUM** (analyze, maybe partial collapse) | Borderline | Some orchestration | Mixed |
| **LOW** (leave alone, log false positive) | Real product sentence | Real orchestration | Boundary or policy |

If unsure, default to MEDIUM and write the analysis out.

## Step 3: Read the inner, outer, and test in this order

Don't open the test first. The test is the *consequence* of the design;
reading it first biases you toward keeping the seam.

Order matters:

1. **Read the inner.** Write its one-sentence purpose. If you can't
   without naming the outer, the inner has no independent product
   sentence.
2. **Read the outer.** Count the LOC after the call to the inner. If
   under ~5 LOC of formatting, the outer is a wrapper. If more, the
   outer has its own concern.
3. **Read the test.** For each `expect()`, ask: would this assertion
   work through the natural boundary (CLI invocation, HTTP request,
   component mount)? If yes, the seam is unnecessary. If no, the seam
   is real — either because the assertion observes internal state
   (smell) or because the boundary is expensive to exercise (real).

## Step 4: Decide

For each candidate, pick one of four:

- **Inline + delete test.** Branch logic is small, exercised on every
  product use, and the test was buying insurance you didn't need.
  Document the risk decision in the commit. The earlier sweep took this option for `runPs` and `runDown`.
- **Inline + rewrite test as integration.** Branch logic is small, but
  the regression risk is non-trivial (cross-process behavior, real
  filesystem effects). Move the test to drive the natural boundary
  (CLI runner, Svelte mount, HTTP client).
- **Keep the split, drop the seam.** The inner has a real product
  sentence but the `deps` parameter is only test-facing. Drop deps,
  rewrite tests to exercise real implementations against controlled
  fixtures.
- **Walk away.** The split is real and the seam protects an expensive
  or dangerous boundary. Log the false positive in `sweep-journal.md`
  (or a `git commit --allow-empty` note) so next month's sweep skips
  it. Example: `runUp` (analyzed but not collapsed — see commit history
  context).

Default to "walk away" when in doubt. The cost of leaving a real seam
alone is small. The cost of inlining a load-bearing one is large.

## Step 5: Surgery (one collapse, one commit)

Never combine multiple collapses in one commit. If you have to roll one
back, you don't want the others to come with it.

The standard sequence for each collapse:

1. Read the SUT and test, end to end. Don't skim.
2. `grep` for the inner function's name across the workspace, excluding
   the test. Confirm one production caller. If you find a second
   caller, abort — the candidate was wrong.
3. Move the inner's body into the outer. Demote any types that were
   exported only for the test (drop `export`).
4. Delete the test file.
5. Typecheck the package. If errors appear, you missed a caller; fix
   it or revert.
6. Run any sibling tests in the package. None should regress.
7. Stage exactly the three files (`SUT.ts`, `SUT.test.ts`, anything
   that referenced the deleted exports). Don't auto-add.
8. Commit with the standard message form:

```
refactor(<pkg>): inline <inner> into the <outer>, drop test seam

<one paragraph on what the seam was and why production never used it>

<one paragraph on where the coverage goes: integration test, type-level
invariant, or honest deletion + risk note>

See [cohesion-over-testability](../../.agents/skills/cohesion-over-testability/SKILL.md).
```

## Step 6: Pay the coverage bill explicitly

For each test you delete, name where the regression coverage now lives:

- **Type-level**: `T extends Disposable`, branded return types, `using`
  declarations. The compiler enforces what the test was watching.
- **Integration test**: an e2e or smoke test that exercises the same
  branch through the natural boundary. Reference it in the commit
  message so a reviewer can run it.
- **Manual + product use**: when the branch is small enough that
  type-checking plus the next product invocation catches regressions
  cheaper than the seam taxed them. Document the risk decision
  explicitly. The old `ps` command checked for dead processes on each invocation, which gave that sweep a concrete manual check.

If you can't name where the coverage goes, you haven't earned the
deletion. Write the integration test first; then delete the unit test.

## Anti-patterns when sweeping

- **Don't sweep based on LOC ratio alone.** Pure-input/output tests
  (parsers, tree algorithms, schema validators) legitimately have many
  cases and big test files. The smell is "test is bigger than its SUT
  AND the SUT has a DI seam," not just the ratio.
- **Don't generalize from one collapse.** Each candidate gets the full
  triage. `runPs` and `runDown` were the same smell; `runUp` looked
  similar and turned out to be different. The procedure exists to
  catch that.
- **Don't combine sweeps with feature work.** Sweep commits should be
  pure refactors with no behavior change. Mixing them with feature
  changes makes review harder and rollback risky.
- **Don't sweep what someone else owns mid-flight.** Check `git log
  --since='1 week ago' -- <file>`. If the file changed recently, ask
  the author before sweeping.
- **Don't add a new abstraction during a sweep.** "I'll extract a
  helper to make this cleaner" is scope creep. Inline first, abstract
  later if a real pattern emerges across multiple call sites.
- **Don't sweep tests you don't understand.** If you can't trace each
  `expect()` to a production behavior, you're not qualified to delete
  it. Read until you are, or skip the candidate.

## Sweep journal (optional but useful)

Keep a `SWEEP-JOURNAL.md` at the package root or repo root with one
line per candidate evaluated:

```
2026-05-13  cli/commands/up.ts          MEDIUM → walk away (inner has product sentence; deps protects dynamic config import)
2026-05-13  cli/commands/down.ts        HIGH → inlined in 9434030a7
2026-05-13  cli/commands/ps.ts          HIGH → inlined in 50a9b0c61
2026-05-13  svelte-utils/session.svelte.ts  HIGH → inlined in d5b61aed8
```

Next month's sweep reads the journal first and skips already-evaluated
candidates unless they've changed.

## When the procedure says "walk away" but you still want to act

Sometimes the procedure says LOW or MEDIUM and you have a non-skill
reason to want the collapse anyway — readability, type cleanup,
preparing for a larger refactor. That's fine, but be explicit:

- Tell the user (or the PR description) that the skill says "walk
  away" and you're overriding because [reason].
- Commit message names the override: `refactor(cli): inline runUp
  despite product-sentence finding — preparing for daemon-lifecycle
  collapse in <upcoming spec>`.
- The skill is a default, not a constraint. Overriding it on purpose
  with a stated reason is fine. Overriding it silently is the smell.

## TL;DR

1. Run greps monthly. Triage by confidence. Read inner → outer → test
   in that order.
2. Default to "walk away" when unsure. One collapse, one commit. Name
   where the coverage goes.
3. The skill is a procedure for finding fossils. The procedure
   includes knowing when not to swing the axe.

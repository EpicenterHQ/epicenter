# Test Deletion Grill

Remove tests and setup that add no useful regression confidence. Simplify the
machinery needed for the behavior that must survive. Use this guidance when
choosing new coverage, pruning a suite, or challenging expensive fixtures.
Test counts, line counts, and coverage percentages identify places to inspect;
they do not decide whether a test earns its cost.

## Challenge, response, resolution

Review every test in scope, but build the argument once per meaningful
opportunity: tests or fixtures sharing a simplification rationale and a
replacement. If the response does not hold for every member, split the group.
Challenge shared setup at the fixture level and check the resulting coverage
across the retained suite.

### Challenge

Name the deletion prize: the tests, fixture machinery, duplicated checks, or
production seams that could disappear. Propose a smaller shape and explain
which behavior it would still expose. Look for a decision that removes a family
of work before polishing individual assertions.

### Response

Trace what the current tests actually exercise through production callers.
Name the plausible defect, triggering condition, and assertion that detects it.
Confirm that the setup can reach the failure; a stalled or instantly resolving
fake may exclude the very behavior the test claims to cover.

For a redundancy claim, name the retained test and verify that it detects the
relevant defect. Similar names, executed lines, or happy-path results do not
establish equivalent coverage. Consider different inputs, real dependency
boundaries, diagnosis, speed, and reliability. Mocked orchestration can protect
real retry, cancellation, ordering, or error-mapping decisions.

Judge replacements against the suite after the complete change. A test also
nominated for deletion cannot justify another deletion. Planned owner coverage
is not retained coverage until it exists and asserts the required behavior.

Count introduced complexity and work transferred to people. A smaller fake
that excludes the failure, or a slower caller test that obscures its cause,
may be a worse bargain.

### Resolution

Keep, rewrite, simplify setup, move coverage to its owner, or delete. Explain
what disappears and what still catches the required failures. If the behavior
is real and remaining coverage is unclear, investigate, keep, or rewrite the
test rather than delete it.

Use these moves to reason; do not manufacture disagreement or write a triple
for each unchanged test. Record consequential changes and non-obvious deletion
claims with concrete evidence. Routine cleanup needs only the usual summary.

Dropping a required product promise is a separate decision for the user unless
already authorized. Test pruning does not authorize changing that promise.

## Example: remove unnecessary Git setup

This is a proposed review entry, not evidence about a particular suite:

> Challenge: These editor race tests start real Git. Replace that setup with
> controlled save completion so the repository fixture can disappear.
>
> Response: The typing race needs a delayed save through the production editor
> path. It does not need Git. A separate history scenario crosses the real Git
> boundary and must retain that integration coverage.
>
> Resolution: Simplify the race fixture and assert that newer typing survives
> the earlier save's completion. Keep the real history scenario. Verify both
> paths before removing their shared setup.

A single instantly resolving save stub would not preserve the race. A response
can reveal a stronger collapse or establish that the current shape should stay.

## Safeguards

Do not delete a test because it is failing. Determine whether the failure is a
bug, stale expectation, or unsettled contract. A grounded contract change can
retire a stale test; making the suite green is not the justification.

Preserve coverage for contracts outside the type system:

- Wire formats, durable identifiers, URL shapes, and persisted layouts.
- Error names and status codes consumed across real boundaries.
- Runtime validation of unknown input.
- Concurrency, idempotency, ordering, retries, cancellation, and cleanup.
- Regression checks for subtle bugs that could recur.

A small constant assertion can pin a real external contract. Comparing the
production value with the protocol's independently specified literal detects a
regression; comparing two values constructed entirely by the test does not.
TypeScript declarations alone do not establish runtime values at unsafe or
external boundaries.

Overlap is a candidate for inspection, not a deletion verdict. Two tests may
protect the same result through different failure mechanisms. Preserve useful
confidence even when a local simplification becomes smaller than its test.

## Inspect and verify

Read the relevant callers and all cases sharing the fixture. Remove setup,
helpers, and fake members only when the surviving tests no longer need them.
Keep members required by a real interface or by the exercised production path;
avoid inventing unused fake behavior. Update test names and file documentation
when their coverage changes.

Run the affected suite after editing to catch broken setup and behavior. A green
suite after deletion does not establish that lost coverage was redundant.
When a specific replacement claim remains uncertain, introduce a temporary
local defect and confirm that the retained assertion fails for the intended
reason. Restore only the probe's changes afterward, preserving unrelated work.
If the retained suite misses the defect, repair the coverage or keep the test.
Do not require a defect probe for every routine deletion.

Report the concrete cuts, meaningful retained coverage, and verification. Keep
commits reviewable when commits are requested; avoid mandatory per-test labels,
count tables, or approval gates based on the number of candidates.

## Smells worth challenging

These are recognition aids, not required output categories:

- Assertions about values constructed only by the test.
- Mocks whose configured responses are echoed without testing a decision.
- Checks that merely prove an export exists when a build check owns that promise.
- Assertions about internal filenames, field names, or helper boundaries.
- Repeated scenarios that add no useful input, boundary, or diagnostic coverage.
- Production exports or splits that exist only so a test can reach internals.

For unreachable failure modes, padded assertions, dead fake behavior, and
misleading docstrings, read [honest-tests.md](honest-tests.md).
For production splits created solely for tests, read
[cohesion-over-testability](../../cohesion-over-testability/SKILL.md) before
editing production code.

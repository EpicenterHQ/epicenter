---
name: computer-use-driven-iteration
description: Improve an interactive product through repeated computer-use simulations, bounded Claude implementation, verification, and reflection to find opportunities to collapse complexity. Use when asked to keep exercising and improving a UI across implementation waves. Skip one-off browser actions, routine fixes, and API-only work without an interactive product to exercise.
---

# Computer-use-driven iteration

Let actual use determine the next implementation wave. Exercise the product,
trace what the interaction reveals, delegate a bounded improvement, verify it
in use, and reconsider the design with the new evidence. Hunt for the owner,
invariant, or smaller promise that makes a family of complexity unnecessary.
Success is a better product with a simpler supported design, not more waves.

Codex owns continuity, decisions, acceptance, and integration. Prefer GPT 6.1
for computer use and Claude Opus 5.5 to direct delegated implementation, with
a Codex helper writing substantial changes. Respect explicit model choices;
report unavailable capabilities and any substitution.
The responsibilities survive changes to model availability. This is a Codex
coordination skill; Claude receives bounded assignments through the linked
delegation skill.

## Establish the outcome and evidence

Choose representative journeys from the user's desired outcome and current
product. Include the transitions that could expose wrong ownership or stale
state: switching items during an operation, interrupting and retrying, closing
and reopening, or reloading after a save. Choose cases for the actual product;
do not turn every pass into an exhaustive checklist.

Establish the source baseline, app instance, and data used for the simulation.
Prefer disposable local data when journeys mutate state. Keep the evidence
traceable to the version exercised. A running worker's newer code is not
evidence about the app currently open in the browser.

Use the available computer-use tools and their documented entrypoints. Exercise
the actual UI; retain screenshots or interaction evidence where they support a
decision. Record the steps, expected behavior, observed behavior, and limits.
Distinguish visual observations, demonstrated failures, and hypotheses about
their causes. A screenshot cannot prove persistence or native hardware behavior.

If UI access is blocked, continue useful source investigation or automated
checks, state which journeys remain unverified, and leave UI acceptance open.
Do not describe those checks as computer-use evidence.

## Choose and execute the next wave

Trace the strongest observation into its actual callers and state owners.
Before editing, explain what is wrong, the proposed change, and why it improves
the desired journey. For a collapse, name what disappears, which guarantee
replaces it, and any work transferred to a caller or person. A problem observed
in the UI can justify changing the underlying model when the evidence supports
that scope. Bring unresolved product tradeoffs to the user.

Within the task's authorization, use
[delegate-claude](../delegate-claude/SKILL.md) for a separable implementation
with observable acceptance criteria. Give Opus the relevant baseline, raw
evidence, affected consumers, allowed changes, and a bounded stop condition.
The delegation skill owns clone preparation, dispatch, correction, and
integration mechanics. Use [consult-claude](../consult-claude/SKILL.md) for an
unsettled question that needs advice rather than implementation. Handle a
small direct fix locally when delegation would cost more than it contributes.

While a worker implements, continue simulations or verification preparation
that do not depend on its result or modify its source. Parallel work earns its
place when it answers a distinct question. Return changed evidence explicitly
to the worker; do not let its assignment drift silently.

Inspect the returned diff, run relevant checks, and integrate accepted work.
Re-exercise the changed journey against the integrated version, including the
adjacent behavior most likely to regress. Distinguish worker-reported checks
from checks Codex reproduced. Commit in coherent waves when requested; the
skill itself does not require a commit after every iteration.

## Reflect and challenge

After every wave, use
[post-implementation-review](../post-implementation-review/SKILL.md) to reread
touched files in their caller context and mentally inline their boundaries.
Ask what the implementation taught us: which wrappers, props, states, checks,
or planned tasks no longer earn their place? Identify the next discriminating
interaction or experiment rather than manufacturing another cleanup.

Use [adversarial-review](../adversarial-review/SKILL.md) at consequential design
checkpoints, when evidence suggests a different owner, lifecycle, public
contract, or smaller promise could remove substantial machinery, and whenever
the user requests it. That skill owns independent reviewer setup and
adjudication. Reflection happens every wave; a full reviewer group does not.
Preserve reviewer independence from the implementation worker.

Use [collapse-pass](../collapse-pass/SKILL.md) when accepted findings call for
sustained removal of unearned indirection. Feed its result back into the same
product journeys. Review agreement and fewer lines do not establish that the
product improved.

## Continue or finish

Choose another wave while there is a grounded improvement worth executing
within the authorized outcome. Stop when the intended journeys pass, accepted
findings are resolved, and remaining candidates lack evidence or require a new
product decision. Do not repeat reviews to obtain a deletion or unanimous
approval. Carry unresolved checks forward explicitly when access or external
conditions prevent completion.

For work spanning waves, retain enough working evidence to resume: accepted
outcome, source and app baseline, observed failures, accepted and rejected
findings, integrated changes, verification, and the next deciding check. Use
existing task notes or evidence locations; a new ledger is not mandatory.
Rewrite remaining work when a collapse makes earlier tasks obsolete.

Finish with the changed product behavior, the complexity removed and its
replacement guarantee, checks actually completed, and material unresolved
acceptance. Keep the user's judgment focused on the outcome.

---
name: product-collapse
description: Develop simpler product behavior with the person by questioning assumed requirements and working backward from what they need. Use when exploring simpler workflows, settings, modes, fidelity, or scope and the product direction needs judgment, or when judging asymmetric wins, meaning whether refusing a small promise would remove disproportionate complexity.
---

# Product collapse

Look for a simpler way for the product to do what the person needs.
Ask which requirements serve that purpose and which ones the current
design brought with it.

Use [dialectic](../dialectic/SKILL.md) to develop the direction together.
Offer something specific the person can recognize, correct, or extend.
Carry forward what they have already decided.

Removing features, steps, or state is a consequence, not the goal.

## Start from what the person needs

Describe what they are trying to accomplish, including what they need
to be able to rely on. Treat existing workflows and guarantees as
evidence of earlier choices. Find out which still matter and why.

If the proposed direction changes what the product is for, say so
plainly.

## Imagine the experience afresh

Ask how you would design this today for that purpose. Look beyond
adjusting the existing screens and settings.

A recurring choice might be resolved once. A mode or degree of fidelity
might be unnecessary. Actions might belong together, or a combined action
might work better as separate decisions. Something the browser or
operating system already does may be enough.

For example, someone who wants to review their week might need one
useful report with a date-range choice. They may have no use for a report
builder with configurable columns, grouping, and saved layouts. That
simpler experience could make the builder unnecessary. But if exploring
the data is the job, the builder may earn its place.

Develop a concrete direction and explain why you favor it. Compare
alternatives when their differences help the person judge the choice.
Use their response to improve the proposal.

## Show what changes

Show what the person does, what gets easier, what they give up, and
what still needs doing. Include interruptions and failures when they
would change the choice.

Account for work added as well as removed. An extra step may make the
whole experience simpler. Removing a step may leave the person with more
to remember, check, or repair later.

Check the code when a claim about what could disappear affects the
decision. Distinguish confirmed removals from possibilities that still
need investigation.

Keeping a capability is a good outcome when it is worth what it costs.

## Work backward from the chosen experience

Once the direction is understood, work out what needs to exist to
support it. Use what already does the job before adding something new.

Before calling something redundant, find out what it remembers.
Unfinished work, the only copy of someone's input, a reviewed decision,
or an action whose outcome is still uncertain may need to survive.

Keep that information until something else reliably holds it or the
chosen experience makes it unnecessary. Check that complexity disappears
rather than moving elsewhere or becoming work the person must do.

Carry settled choices forward without reconfirming each detail. Bring
back consequential choices that remain unresolved. Agreement on a
direction does not by itself authorize implementation.

Use [collapse-pass](../collapse-pass/SKILL.md) to carry an authorized
change through its callers, remove what it made unnecessary, and verify
the result. Use disposable data for app experiments.

Read [the examples](references/examples.md) for illustrations of this
judgment. They show questions worth examining, not changes to apply by
keyword or a required number of alternatives.

## Asymmetric wins

An asymmetric win is a refusal that returns more complexity than it costs
in capability: refuse 10 to 20 percent of the functionality to collapse 80
to 90 percent of the complexity. The spine:

```txt
Preserve the product sentence.
Refuse the small promise.
Delete the code family.
```

The ratio is a way to spot the opportunity, not arithmetic and not a
quota. Do not remove arbitrary features. Find the one small promise (a fast
path, old shape, rare mode, compatibility alias, fallback parser, exact
reproduction) that owns a disproportionate code family, then decide whether
refusing exactly that leaves the product sentence intact. A second path
feels cheap to add, but it is a permanent invariant.

1. Name the product sentence and the workflow that must stay true.
2. List the candidate refusals and circle the one that forces the most
   extra surface area.
3. For each, name the capability lost and the machinery that disappears:
   methods, adapters, error variants, tests, docs branches, UI states,
   fixtures.
4. Separate refusals that change the product's purpose from those that
   drop a convenience inside the same workflow.
5. Prefer the smallest loss that removes the second shape, not the largest
   deletion.
6. Remove it from the sentence. If the sentence still describes a useful
   product, refuse the promise and write the refusal into the spec.
   Otherwise keep the feature and say why.

Keep it when the loss is load-bearing: exact detail that carries
comprehension, accessibility, trust, brand, or a regression-sensitive
state. Do not ship drift under "good enough", and do not count a deletion
that only moves complexity somewhere harder to see.

Complexity is evidence, not a verdict: a feature can own a large code
family and still be worth keeping. Establish the valuable workflow before
ranking deletion prizes, and treat a change to the product's purpose as its
own product decision. In architecture the expensive promise is often
keeping both mental models alive; a half-old, half-new system is the
usual cost.

Write the decision in the spec, for example:

```txt
Product sentence: All social sign-in routes through the API-hosted page
  via OAuth 2.1 PKCE.
Candidate refusal: browser SPAs use Google GIS for a one-second sign-in.
Deletion prize: signInWithIdToken, OIDC provider narrowing, per-app GIS
  helpers, a blocked-browser UI state, two docs branches, two test paths.
User loss: Google sign-in is a few seconds slower in browser SPAs.
Decision: Refuse it. The loss is small; the second auth shape is permanent.
```

Use the [clean-breaks reference](../rethink/references/clean-breaks.md) to
carry out the replacement and delete the old path.

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

Sometimes giving up a small promise removes a lot of code. Refusing 10 to
20 percent of the features can remove 80 to 90 percent of the complexity.
The pattern:

```txt
Keep the product sentence.
Refuse the small promise.
Delete the code that existed only for it.
```

The percentages help you spot a candidate. They are not a target, and you
should not cut features just to hit them. Look for one small promise, such
as a fast path, an old format, a rare mode, a compatibility alias, a
fallback parser, or exact reproduction, that drags a large family of code
along with it. Then ask whether the product still does what its sentence
says without it. A second path always looks cheap to add, and then it has
to be kept working forever.

1. Write the product sentence and the workflow that must keep working.
2. List the promises you could refuse. Pick the one that forces the most
   extra code.
3. For that one, write down what users lose and what code goes away:
   methods, adapters, error cases, tests, docs, UI states, fixtures.
4. Check whether refusing it changes what the product is for, or only drops
   a convenience.
5. Choose the smallest loss that removes the second way of doing things,
   not simply the biggest deletion.
6. If the sentence still describes something useful, refuse the promise and
   write that down in the spec. If not, keep the feature and say why.

Keep the feature when the loss really matters: when the exact detail helps
people understand, access, or trust the product, or protects something that
has broken before. Don't call something "good enough" and ship a
half-working version. Make sure the code actually goes away instead of
moving somewhere harder to see.

Write the decision down, for example:

```txt
Product sentence: all social sign-in goes through the API-hosted page
  using OAuth 2.1 PKCE.
Promise to refuse: browser apps can use Google's one-tap sign-in for a
  one-second login.
Code that goes away: signInWithIdToken, OIDC provider narrowing, per-app
  Google helpers, a blocked-browser UI state, two docs branches, two test
  paths.
What users lose: Google sign-in takes a few seconds longer in browser apps.
Decision: refuse it. The loss is small and a second way to sign in would
  have to be kept working forever.
```

Use the [clean-breaks reference](../rethink/references/clean-breaks.md) to
carry out the replacement and delete the old path.

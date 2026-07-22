---
name: fresh-context-review
description: Fresh-context review and adversarial review for concrete diffs, state machines, type shapes, lifecycle boundaries, and confusing abstractions. Use when the user asks for "fresh-context review", "fresh eyes", an independent reviewer, adversarial review of a diff, a state-machine audit, or whether a type or lifecycle shape earns itself. Not for generic helper delegation, executor prompts, ordinary final review, or interactive planning interviews.
---

# Fresh Context Review

Read the change like a capable TypeScript developer who has not been part of
the conversation, then push until the lifecycle, names, and type shapes either
become obvious or collapse to something simpler.

This is not a normal code review. It is a structured challenge pass.

## Review Move

Use a subagent only as the backend for this review move, when available and
when fresh context is useful. The skill owns the adversarial review question,
not generic helper delegation.

Give the reviewer a bounded prompt with:

- exact files to read
- staged diff or target branch to inspect
- hard invariants
- skills to load
- one review question
- expected output shape

If subagents are not available, simulate the same posture locally: read only the
files named by the task first, then widen by caller search only when a question
requires it.

Findings are hypotheses, not patches. Verify each against the actual source
before applying. This skill delegates review, never execution.

Load only the relevant local skills before reviewing:

- `typescript` for type ownership, local shape copies, and discriminated unions
- `first-read-review` for first-read clarity
- `refactoring` for caller counts and helper inlining
- `greenfield-clean-breaks` when the user says "greenfield", "no users",
  "clean break", "refuse compatibility", asks whether old behavior can be
  deleted, or the review points to a public-shape or ownership break
- `define-errors` and `error-handling` when `Result`, `Err`, `Ok`, or
  `defineErrors` shapes are involved
- `collapse-pass` when the user asks to shrink indirection or delete state
- the domain skill for the package being reviewed, such as `auth`,
  `data-lens`, `svelte`, or `tauri`

Read [references/type-lifecycle-review.md](references/type-lifecycle-review.md)
when the review centers on type protocols, state machines, lifecycle
transitions, or helper boundaries.

## The Posture

Assume the code might be right, but the explanation might still be too
expensive. Your job is to make the design earn its shape.

Ask these questions in order:

1. What is the one sentence this code must make true?
2. Which values are durable state, which values are runtime state, and which
   values are just network observations?
3. Which layer owns each invariant?
4. What would a new developer misunderstand on the first read?
5. What is the simplest design that would still satisfy the hard invariants?
6. If compatibility pressure has been released, what behavior can we refuse to
   delete a whole code family?
7. Which helpers have one caller, and do they earn their names?
8. Which type aliases are real contracts, and which are local ceremony?
9. Would `Result` plus `defineErrors` say this better than a custom union?
10. Are tests asserting public behavior or implementation trivia?

Do not accept "it is explicit" as a sufficient answer. Explicit code can still
be the wrong boundary. A state, helper, or type earns its place only when it
prevents misuse, names real domain vocabulary, isolates unsafe input, or removes
more confusion than it adds.

## Output Shape

Use this shape for the final review:

```txt
Files read
path/
|-- file-a.ts
`-- file-a.test.ts

Lifecycle
...

Findings
1. [severity] file:line Problem, why it matters, correction.

Would simplify
- ...

Would keep
- ...

Test gaps
- ...

Verdict
Keep / change / block, with one concrete reason.
```

Findings must lead. Do not bury bugs under prose.

## When Editing

If the user asks you to act on the review:

1. Add or adjust focused tests first.
2. Make the correction that resolves the problem at its real owner. Use
   `greenfield-clean-breaks` when compatibility pressure has been explicitly
   released or the correction changes public shape.
3. Re-read every touched file.
4. Run package typecheck and tests.
5. Stage only the files you touched when the user asks for staging.

Do not fold unrelated cleanup into the change. Fresh eyes does not mean wider
scope.

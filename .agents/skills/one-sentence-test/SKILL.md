---
name: one-sentence-test
description: Test a product, API, utility, or design by stating what it actually does in one sentence. Use when auditing coherence or looking for orphaned surfaces, duplicate verbs, or inert abstractions, not for plain code-comprehension questions.
metadata:
  author: epicenter
  version: '2.0'
---

# One-Sentence Test

Related skills: use [post-implementation-review](../post-implementation-review/SKILL.md)
when the sentence is part of a post-change second read, and
[rethink](../rethink/SKILL.md) when the sentence
drives an API, ownership, lifecycle, or package boundary change.

**Core move.** Before continuing, stop and write one concrete sentence that describes the subject. Name the objects, verbs, and scope. No marketing words. No "flexibly handles." No "unified experience." Then use the sentence as an audit tool.

**Show your work.** Write the sentence out in your response, visibly. The value is in the reader seeing the gap between what the prose claims and what the subject actually is: that only happens if the reduction is on the page, not silent in your head.

If the sentence keeps drifting as you write it, **the design isn't coherent yet**: that's the finding. Name the ambiguity before continuing.

The move has two applications. They're distinct lenses on the same discipline: pick the one that fits the subject.

## Application A: Cohesion Audit (top-down)

**Subject**: a design, spec, or surface (commands, endpoints, options, tables) whose coherence is in question. The sentence is the thesis; every surface is audited against it.

Signals:

- A design discussion is wrapping up and code is about to start
- A spec draft exists but its sections feel unrelated
- A command / endpoint / option list is growing past ~5 items
- Two contributors describe the same system differently
- About to add a new surface (command, route, method) and can't cleanly justify it
- User says "what is this", "elevator pitch", "in one sentence"

Audit the thesis against each surface:

- Does this surface serve the sentence?
- If removed, would the sentence still be true?
- Is there a verb in the sentence with no surface yet?
- Do two surfaces serve the same verb redundantly?
- Is a small convenience feature forcing a second product sentence?
- Is there an asymmetric win: refusing 10-20 percent of functionality to
  collapse 80-90 percent of complexity?

After the surface audit, run an asymmetric wins check. This skill only detects
the opportunity; [asymmetric-wins](../asymmetric-wins/SKILL.md) owns the
decision, candidate list, and refusal template.

```txt
1. List the convenience features, rare modes, old shapes, and fast paths.
2. Circle the one that forces the most extra surface area.
3. Remove that one from the sentence.
4. If the sentence still describes a useful product, run the asymmetric-wins
   pass.
```

This matters most before greenfield implementation, when AI can make a second
path feel cheap. The second path is still a permanent invariant.

### Worked example: notification API audit

A notification API has grown: `notify.send`, `notify.schedule`, `notify.batch`, `notify.digest`, `notify.preferences`, `notify.channels.register`, `notify.history`. Feels bloated.

First try: "A notification system." Too vague: fails.

Second try: "Send messages to users across channels." Doesn't cover `preferences` or `history`.

Third try: **"Deliver a message to a user on their preferred channel, honoring their quiet hours, and remember we sent it."**

Audit:

- `send`: deliver ✓
- `preferences`: preferred channel + quiet hours ✓
- `channels.register`: preferred channel ✓
- `history`: remember we sent it ✓
- `schedule`: not in sentence. Separate product (a scheduler).
- `batch`, `digest`: sentence says *a* message to *a* user. Different thesis.

Finding: `schedule`, `batch`, `digest` belong to a sibling product. The cohesion test surfaced what the audit existed to find.

### Good sentences vs. bad

Bad: *"A CLI for managing your workspace."* Vague. Could be anything.

Good: *"Introspect and invoke `defineQuery`/`defineMutation` actions in `epicenter.config.ts`, either locally or on a peer that's online right now."*

The good sentence names the objects (actions), their source (config file), the verbs (introspect, invoke), and the scope (local or live peer). Every CLI command maps to one of those verbs or objects. Anything else is a surface that does not belong.

## Application B: Value-Add Audit (bottom-up)

**Subject**: a single utility, wrapper, flag, endpoint, or config option whose value is in question. The sentence describes what the code *actually does*, ignoring docs, then specializes under the defaults in use.

Signals:

- Evaluating whether an abstraction earns its keep
- Reviewing a wrapper around an existing utility
- Writing docs for something that feels over-documented
- Before recommending wrapping, extending, or composing an existing utility: do the reduction first
- When reviewing your own just-written abstraction before sending it
- When code and docs seem to disagree, or docs describe capabilities you can't locate in the body
- User asks "what does X actually do" or "is this useful": don't paraphrase docs, do the reduction. A plain comprehension question gets a direct answer, not this pass.

Three reductions in order. Don't skip.

1. **Strip-docs reduction.** Ignore the name, JSDoc, README. Read the body. Finish this sentence in plain language: *"This function ______."* No adjectives. Just the mechanics.

2. **Default-config reduction.** Specialize: *"Under the defaults actually in use, this function ______."* Features gated behind non-default options don't count. If a knob is set to `Infinity`, `false`, or `null`, the code path it guards is inert.

3. **Caller-need check.** Does the caller's use case actually need the default-config version? If not, you've found a mismatch: wrong tool, wrong defaults, or a wrapper adding zero value.

### Worked example: createDisposableCache

`createDisposableCache` has a page of JSDoc about refcounted Y.Doc lifecycles, cache eviction, idle timeouts, deterministic cleanup.

```
Strip-docs reduction:
  "Dedup by id, refcount open/close, destroy when refcount hits
   zero after an idle timeout."

Default-config reduction (gcTime: Infinity):
  "Dedup by id. Close is explicit: docs live forever."
  → Refcount is inert. No eviction ever fires.

Caller-need check: wrapping the singleton openFuji with this.
  The caller has exactly one id and one lifetime. Dedup of a
  singleton is a no-op. Explicit close already exists on the
  underlying doc.
  Verdict: the wrapper contributes zero. Delete it.
```

The reduction did the work. The JSDoc had been hiding that the defaults neuter the main feature, and the caller didn't need the main feature anyway.

## Common Reveals

- **Inert knobs**: a default (`Infinity`, `false`, `null`) disables the mechanism the docs advertise.
- **Singleton wrappers**: dedup/cache utilities wrapped around a caller that only ever has one instance.
- **Ceremony with no payoff**: "lifecycle management" that reduces to "call close when done", which the underlying type already supports.
- **Docs describing aspirations**: prose describes what the abstraction *could* do under other configs, not what it does here.
- **Orphaned surfaces**: commands / endpoints that don't map to any verb in the thesis.
- **Drifting thesis**: when you can't finish the sentence without contradicting yourself, the design hasn't converged.

## Anti-Patterns

- **Reading the JSDoc first and paraphrasing it.** Not a reduction: it's a summary of the marketing. Read the body.
- **Stopping at the strip-docs reduction.** "It dedups and refcounts" sounds useful until you specialize to the config in use.
- **Defending the abstraction by listing features the caller doesn't use.** If the caller passes defaults that disable feature X, feature X is not a justification.
- **Calling the thesis "a CLI for workspaces" or similar fluff.** An abstract sentence can't audit anything.

## Success Criteria

After the move, you can state in one concrete sentence what the subject *is* (cohesion audit) or what it's *buying this caller* (value-add audit). If you cannot, or the honest sentence is "nothing, really", the design or abstraction does not earn its keep.

## What This Skill Is Not

- Not a naming exercise. The sentence is an analysis tool; the codename stays whatever it was.
- Not a marketing tagline. Taglines abstract; this sentence must be concrete.
- Not a complete spec. It's a coherence gate before specs get written, or a sniff test before an abstraction lands.

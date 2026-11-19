# 0044. Tool approval is a per-conversation policy, resolved per call

- **Status:** Accepted (design; lands with the first tool consumer)
- **Amended by:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md): the policy seam (read-only / ask / auto, defaulted from the agent) is unchanged, but the underlying mechanism is no longer the durable doc-mediated approval of ADR-0042. The loop is client-side and the human is present, so an `ask` resolves by pausing the loop synchronously for an in-client decision.
- **Date:** 2026-06-20
- **Relates:** ADR-0042 (the doc-mediated approval mechanism this policy drives), [ADR-0030](0030-agents-are-immutable-capability-bundles.md) (the agent the mode defaults from), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (tools are workspace actions), [ADR-0031](0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) (the single-writer region the decision is written into)

## Context

ADR-0042 made tool approval a durable doc record: the worker writes a tool-call in an awaiting-approval state and stops, any device writes the decision into a client-owned single-writer region, and the worker resumes by re-reading the doc. It left the decision rule as a sentence, "queries auto-run, mutations need approval." Local Books, the first consumer, needs more than that binary: read queries always auto-run, but a mutation (mark reviewed, add a note) wants a per-conversation choice between never (read-only), ask-each-time, and trust-and-run, and a "judge whether this mutation is safe" mode is clearly coming. A static `needsApproval` flag on each tool (TanStack AI's shape) cannot express a per-conversation mode or a later classifier, and it puts the choice on the wrong owner: the tool, not the conversation.

## Decision

**Whether a tool call needs approval is a policy resolved at the call site, not a static per-tool flag:**

```txt
resolveApproval(toolCall, ctx) -> 'auto' | 'ask' | 'deny'
```

The mode is a per-conversation setting, defaulted from the agent (ADR-0030). Three policies ship:

```txt
read-only   queries auto;  mutations deny    (the agent literally cannot write)
ask         queries auto;  mutations ask     (doc-mediated approval, ADR-0042)   [default]
auto        queries auto;  mutations auto     (run immediately, still audited)
```

The doc-mediated mechanism (ADR-0042) is unchanged underneath: the policy only decides whether a given call resolves to `auto` (run now), `ask` (write awaiting-approval, stop, wait for the doc), or `deny` (refuse and let the model continue). Even an `auto` mutation writes its tool-call and tool-result parts into the doc, so every action is auditable and replayable on every device. A **classifier policy** (judge each mutation, auto-approve the safe ones, escalate the risky ones to `ask`) is a future fourth policy that slots into the same seam without touching the mechanism. The dangerous all-auto policy ships first because it is the free case, the seam returning `auto`; the classifier is additive, never a precondition.

## Consequences

- One mechanism (ADR-0042), one seam, N policies: adding the classifier is purely additive, not a rework.
- `read-only` is a real safety floor distinct from `ask`: the mutation tools are not offered to the model at all, so the worst a compromised prompt can do is read.
- The mode is a conversation setting, not a per-tool rebuild; switching it mid-conversation is a policy swap, and an "approve all pending this turn" affordance is a batch over the same per-call decisions.
- Audit is free: the doc holds every tool-call and tool-result part regardless of mode.

## Considered alternatives

- **A static `needsApproval` flag per tool (TanStack AI's default).** Rejected: it cannot express a per-conversation mode or a future classifier, and it owns the decision on the tool instead of the conversation.
- **Ship the classifier first.** Rejected: it is a whole component (an LLM or rules judge). The seam plus the three trivial policies prove the shape now, and the classifier drops in later as one more policy.

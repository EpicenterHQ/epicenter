# 0030. Agents are immutable capability bundles; arbitrary code runs only on a trusted box

- **Status:** Accepted
- **Date:** 2026-06-18
- **Note (2026-06-20), per [ADR-0043](0043-an-agent-answers-where-its-capability-lives.md):** the bundle model here stands (an agent is a model + tools + trust location, immutable for the conversation). What ADR-0043 corrects: Epicenter runs no per-user answering worker, so "managed agents backed by the metered hosted worker" below is superseded. A capability-free agent answers in the **client** over Epicenter's metered inference stream; a local-data agent answers on the user's **daemon**. Epicenter still publishes a curated catalog and still runs no arbitrary user code; it simply hosts no per-user answerer.

## Context

ADR-0025 binds a conversation to one immutable agent and leaves the agent's makeup to "configuration," and ADR-0035 puts workers on a coordination box that may be Epicenter's or the user's own. That raises the question those two defer: how is an agent actually constituted, and may a user ship arbitrary code as one? The answer has to hold the privacy line (you should know what saw your data and what it could do) and keep Epicenter's hosted surface safe, while still letting a user point a local model with local-data tools at their own box.

## Decision

An agent is an immutable capability bundle: a model, a tool set (published actions per ADR-0021, plus bounded read tools like a read-only SQL query), and a trust location, which is the worker host that answers as it. You pick an agent from a catalog when you start a conversation; you do not assemble a model and tools per turn. The bundle is immutable for the life of the conversation (ADR-0025), so what a conversation can reach never shifts underneath it. To use a different bundle you fork.

The catalog has two sources, and the user sees their union. Epicenter publishes a curated set of managed agents, each a well-known `AgentId` backed by the metered hosted worker. The user authors their own agents in their coordination box's config, free to wire a local model and local-data tools under their own trust. Presence decorates each entry with live or offline; it is not routing truth (ADR-0025).

<!-- doc-path-check: ignore-next-line -->
Arbitrary code is bounded by the trust location, not by a flag. Authoring an agent that runs arbitrary TypeScript or shell is allowed only where trust already exists, which is the user's own box. Epicenter's hosted infrastructure runs only Epicenter-published bundles, with a fixed model and published-action tools and no arbitrary code, until the sandbox earns the right to run untrusted code on shared infrastructure (the Model 2 coding-worker lane, `specs/20260617T235900-v2-coding-worker-sandbox-and-harness.md`). So "bring your own agent" means run it on your box, not upload code to Epicenter's.

## Consequences

- The privacy guarantee of ADR-0025 now covers capabilities, not just routing. Because the bundle is declared and immutable, you always know which model saw a conversation and which tools could fire in it, with no mid-conversation drift.
- The catalog is the discovery surface. Naming an agent needs a config entry (Epicenter's or yours), so a configured-but-offline home daemon is still a valid binding; the conversation doc is the durable mailbox it reads when it wakes.
- Epicenter's hosted surface stays small and safe: a curated set with no arbitrary-code attack surface. Growing what Epicenter offers is publishing another bundle, not opening a code-upload endpoint.
- A local agent is first-class, not a downgrade. The worker tier of ADR-0035 is what makes "my own model, my own data, my own box" a normal catalog entry rather than a special case.
- Forecloses per-turn model or tool selection (the capability version of the per-message targeting ADR-0025 refused), a global "any tool, any chat" mode, and arbitrary user code on Epicenter's infrastructure before the sandbox exists.

## Considered alternatives

- **Assemble model and tools per conversation or per turn.** Rejected: capability drift breaks "what could this conversation reach," the same reason ADR-0025 refused per-message targeting. The immutable bundle is the capability analog of the immutable agent binding.
- **Let users upload arbitrary agent code to Epicenter Cloud now.** Rejected: arbitrary code on shared infrastructure needs the sandbox (V2). Until then it runs where trust already exists, on the user's own box.
- **Ship one built-in agent only.** Rejected: it forecloses local-model and private-data agents, which are the whole point of the worker tier.

# 0049. Inference is its own box; the daemon never infers; the client loop talks to a swappable inference server

- **Status:** Superseded
- **Date:** 2026-06-21
- **Supersedes:** [ADR-0038](0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) (the daemon no longer resolves a `ChatStream` or answers; inference leaves the daemon entirely)
- **Superseded by:** [ADR-0618](0618-epicenter-hosts-no-ai-service.md), Epicenter's inference: Epicenter runs no inference or transcription gateway, bills no AI credits, and keeps no local model, and an AI connection survives only as the CLI's bring-your-own-key keychain entry.
- **Relates:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client owns the loop; the daemon provides data as dispatched actions), [ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md) (the metered inference stream this names a box), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (tools are dispatched actions), [ADR-0030](0030-agents-are-immutable-capability-bundles.md) (an agent's model and tools), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (the relay stays content-blind), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the wire this box speaks)
- **Amended by:** [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (2026-06-22): the BYOK arm "Epicenter's gateway when passed through" is withdrawn. The hosted gateway is house-key-only and always metered; a user's own provider key lives only on a custom inference backend, the self-hosted/local arm this ADR already named as the clean home.

## Context

<!-- doc-path-check: ignore-next-line (historical: epicenter-provider.ts is deleted by this decision) -->
ADR-0047 put the agent loop in the client and made the daemon a data-and-tools provider that "never runs inference." But [ADR-0038](0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) still has the daemon resolve a `ChatStream` (`byok ?? metered ?? null`) and answer, and the code still carries that arm: `chatStreamFromAdapter` in `packages/ai-adapters/src/index.ts` and the daemon's `resolveChatStream`. Both live consumers already answer through the metered client path instead (`packages/client/src/epicenter-provider.ts`, used by `apps/vocab/epicenter-engine.ts` and opensidian), so the daemon-inference arm is a pre-0047 leftover that contradicts the merged decision. Separately, "blind cloud" became overloaded: the **relay** (ADR-0035) is genuinely content-blind, but the **metered inference stream** (ADR-0033) forwards the prompt and tool definitions to the provider (`epicenter-provider.ts:190-195`) and is not content-blind at all. The two are different things wearing one word.

## Decision

**Inference is its own node role, an *inference server*: a box whose only job is to turn a prompt plus a tool catalog into a token stream. It is the only role that infers. The daemon never infers; it holds data and runs dispatched actions ([ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md)). The client agent loop ([ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md)) talks to one inference server, chosen by configuration, and is the swap point.**

- **Four roles, each doing one thing.** *Client* runs the loop and binds the others. *Inference server* turns messages+tools into tokens (one stateless turn per request; it returns the model's tool calls and stops, the client executes them). *Daemon* holds data and runs actions; never infers. *Relay/anchor* is content-blind coordination ([ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md)); never infers. One physical machine may play several roles, but the roles are distinct.
- **The inference server is swappable by configuration**, not a compile-time import. The loop's `AgentEngine` (`packages/agent/src/loop.ts`) is already a client of a single inference contract; pointing it at a different base URL points it at a different inference server. Epicenter hosts a metered one; a user can self-host one (their key, or a local model); a user can point at a third-party one.
- **"BYOK" is a key handed to an inference server, never to a daemon.** A BYOK key lives on the box that infers (Epicenter's gateway when passed through, or a self-hosted/local server), used for that request and unmetered. The daemon never holds a provider key for inference.
- **"Blind" is retired as a single word.** The relay is *content-blind*. The inference server is a *stateless inference turn*: it sees the prompt and tools as accepted egress to the model ([ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md), [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md)'s "the data leaves only as a tool result"), but owns no loop, executes no tool, and keeps no transcript.

What carries forward from ADR-0038: the three inference *flavors* (metered house key, BYOK key, local model) survive, but as flavors of an **inference server**, not as a daemon's `??` chain. The "no placeholder" and "spending credits is a deliberate opt-in" principles survive as properties of the metered inference server.

## Consequences

<!-- doc-path-check: ignore-next-line (historical: ai.ts is later deleted by ADR-0051) -->
- The daemon-inference arm is deleted: `chatStreamFromAdapter`, the daemon `resolveChatStream`/answerer, and the daemon-BYOK concept go. The metered client path (`epicenter-provider.ts`) and the server route (`packages/server/src/routes/ai.ts`) stay as the inference server's two halves.
- Self-hosting and local models become first-class: any box that speaks the inference contract is an inference server, so "run my own" and "point at Ollama" are configuration, not new code (see [ADR-0050](0050-the-inference-contract-is-openai-compatible.md)).
- This reaffirms ADR-0047's foreclosure of an agent that reasons with no client open: if a scheduled or autonomous agent becomes a real need, it reopens a *server-run loop* explicitly; it does not reopen daemon inference.
- The vocabulary is honest: a future reader cannot mistake the metered stream for content-blind, because the box is named for what it does (a stateless inference turn), not for a privacy property it does not have.

## Considered alternatives

- **Keep ADR-0038's daemon `ChatStream` chain.** Rejected: it contradicts ADR-0047 ("the daemon never runs inference") and conflates a data box with an inference box. The arm is already unused by both live consumers.
- **Fold inference into the daemon for self-hosting (BYOK on the daemon).** Rejected: it puts a provider key and an inference runtime on the data box, re-tangling two roles. A self-hosted *inference server* is the clean home for a self-hosted key or local model; the daemon stays data-only.
- **Keep one word, "blind cloud," as an umbrella.** Rejected: it is the exact trap that misled this design pass (a prior session, an external review, and a draft ADR all assumed the inference path was content-blind). Naming each property kills the trap.

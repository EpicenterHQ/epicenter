/**
 * `@epicenter/agent-protocol`: the contract the client agent loop (ADR-0047) and
 * an inference engine (ADR-0049/0050) agree on, and the only thing they share.
 *
 * The loop core lives in `@epicenter/agent`; an OpenAI-compatible
 * engine is built in `@epicenter/client`. Neither package depends on the other,
 * so these types live in this leaf (its only dependency is `wellcrafted/json`)
 * and both import them. That replaces the hand-synced "structural twin"
 * definitions the two packages used to carry, so the wire shape can no longer
 * drift between the side that produces it and the side that consumes it.
 *
 * The vocabulary is the loop's own, not a vendor SDK's: an OpenAI-compatible
 * engine parses OpenAI SSE deltas into these chunks, so the loop only ever sees
 * an {@link EngineChunk} and swapping the inference backend is the engine's
 * concern, never the loop's.
 */
import type { JsonValue } from 'wellcrafted/json';

/**
 * One tool call inside a prompt transcript, in the OpenAI/TanStack
 * function-call shape: a stable id, the `function` discriminant, and the
 * arguments as a JSON string. The OpenAI-compatible engine maps this to a
 * `tool_calls[]` entry.
 */
export type ModelToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

/**
 * A frozen transcript message: the prompt shape the inference engine consumes.
 * A `user`/`assistant` message carries prose `content`; an `assistant` message
 * may carry `toolCalls`; a `tool` message carries one tool result keyed by
 * `toolCallId`. The loop produces these from its persisted `AgentMessage`s
 * (a TanStack `ModelMessage` minus the multimodal and reasoning fields we never
 * emit), so the request body stays byte-identical across an engine swap.
 */
export type ModelMessage = {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	toolCalls?: ModelToolCall[];
	toolCallId?: string;
};

/**
 * One streamed event from an engine: a prose delta, one completed tool call the
 * model asked for, or a turn-ending failure. The engine owns provider quirks: it
 * accumulates a provider's streamed (and possibly fragmented or index-less)
 * tool-call deltas and emits one finished `tool-call` with parsed input, so the
 * loop never reduces partial arguments itself. A turn ends when the stream
 * completes with no tool calls collected; the loop never reads a provider finish
 * reason (some providers send `finish_reason: "stop"` mid-tool-call).
 */
export type EngineChunk =
	| { type: 'text-delta'; delta: string }
	| {
			type: 'tool-call';
			toolCallId: string;
			toolName: string;
			input: JsonValue;
	  }
	| { type: 'run-error'; message: string; code?: string };

/**
 * One tool offered to the model, the subset the wire needs: name, description,
 * and input schema. `kind` and `title` are loop concerns the engine never sees,
 * so the loop's fuller `AgentToolDefinition` is assignable here.
 */
export type AgentEngineToolDefinition = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

/** What the loop asks the model on one step: the prompt plus the live tools. */
export type AgentEngineRequest = {
	messages: ModelMessage[];
	tools: AgentEngineToolDefinition[];
};

/**
 * One model call: a snapshotted prompt and the available tools in, a stream of
 * {@link EngineChunk}s out. It runs one model invocation and never executes a
 * tool or reads the store (ADR-0033's pure token source). The Epicenter metered
 * stream, a self-hosted gateway, and a local model all satisfy it.
 */
export type AgentEngine = (
	request: AgentEngineRequest,
	signal: AbortSignal,
) => AsyncIterable<EngineChunk>;

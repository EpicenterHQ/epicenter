/**
 * The engine contract: what the agent loop (ADR-0047) and an inference engine
 * (ADR-0049/0050) agree on, and the only thing they share.
 *
 * The loop (`./loop.ts`) consumes an {@link AgentEngine}; the OpenAI-compatible
 * engine (`./chat-engine.ts`, over `ai.chat`) produces one. Neither imports the
 * other, so the contract lives here and both import it.
 *
 * The request speaks the OpenAI vocabulary: the loop's transcript goes out as
 * the client's chat messages and its tools as the client's tool definitions.
 * The answer comes back as the loop's small {@link EngineChunk} stream, so a
 * provider's streaming quirks stay in the engine and never reach the loop.
 */
import type { JsonValue } from 'wellcrafted/json';
import type { ChatMessage, ChatTool } from '../client.js';

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

/** What the loop asks the model on one step: the transcript plus the live tools. */
export type AgentEngineRequest = {
	messages: ChatMessage[];
	tools: ChatTool[];
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

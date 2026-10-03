/**
 * The OpenAI-compatible provider (ADR-0050): {@link createOpenAiAgentEngine}, an
 * {@link AgentEngine} the client agent loop (ADR-0047) drives over the OpenAI
 * Chat Completions wire. It POSTs `${baseURL}/chat/completions` with the
 * transcript as OpenAI messages and the live catalog as OpenAI tools, then parses
 * the streamed `chat.completion.chunk` SSE deltas into the loop's
 * {@link EngineChunk} vocabulary.
 *
 * The base URL is the swap point (ADR-0049): Epicenter's metered gateway, a
 * self-hosted gateway, or any OpenAI-compatible backend (Ollama, vLLM,
 * OpenRouter). `fetch` carries auth (a bearer header), so this engine never owns
 * a key; metering, house-key custody, and BYOK passthrough live behind the
 * gateway, invisible here.
 *
 * Streamed tool calls are not uniform across providers (ADR-0050). OpenAI
 * fragments a call's arguments across many deltas correlated by `index`; Gemini's
 * OpenAI-compatible endpoint sends each parallel call complete in one delta but
 * omits `index` (verified, Wave 1). The reducer below keys by `index` when
 * present and treats an index-less delta as its own complete call, so two
 * parallel Gemini calls never merge into one with concatenated, invalid
 * arguments.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type {
	AgentEngine,
	AgentEngineToolDefinition,
	EngineChunk,
	EngineFetch,
	ModelMessage,
} from './agent-engine.js';
import { joinUrl } from './connection.js';

/**
 * Everything the engine needs for one turn, read per turn so a backend or model
 * switch takes effect on the next turn (ADR-0054): the resolved transport
 * (`fetch` + `baseURL`) plus the model and the system prompts to prepend.
 */
export type OpenAiTurnContext = {
	fetch: EngineFetch;
	baseURL: string;
	model: string;
	systemPrompts: string[];
};

/** An OpenAI Chat Completions message, the subset we send. */
type OpenAiMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| {
			role: 'assistant';
			content: string;
			tool_calls?: Array<{
				id: string;
				type: 'function';
				function: { name: string; arguments: string };
			}>;
	  }
	| { role: 'tool'; tool_call_id: string; content: string };

/** An OpenAI Chat Completions tool, the subset we send. */
type OpenAiTool = {
	type: 'function';
	function: { name: string; description?: string; parameters: unknown };
};

/** One `tool_calls[]` delta in a streamed chunk. */
type OpenAiToolCallDelta = {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
};

/** One streamed `chat.completion.chunk`, the fields we read. */
type OpenAiStreamChunk = {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: OpenAiToolCallDelta[];
		};
	}>;
	error?: { message?: string; code?: string | null; type?: string };
};

/** A tool call accumulated across one or more deltas. */
type PendingToolCall = { id: string; name: string; args: string };

/** Map one transcript message to its OpenAI Chat Completions shape. */
function toOpenAiMessage(message: ModelMessage): OpenAiMessage {
	if (message.role === 'user') {
		return { role: 'user', content: message.content };
	}
	if (message.role === 'tool') {
		return {
			role: 'tool',
			tool_call_id: message.toolCallId ?? '',
			content: message.content,
		};
	}
	const toolCalls = message.toolCalls ?? [];
	return {
		role: 'assistant',
		content: message.content,
		...(toolCalls.length > 0 && {
			tool_calls: toolCalls.map((call) => ({
				id: call.id,
				type: 'function' as const,
				function: {
					name: call.function.name,
					arguments: call.function.arguments,
				},
			})),
		}),
	};
}

/** Map one tool definition to its OpenAI Chat Completions shape. */
function toOpenAiTool(definition: AgentEngineToolDefinition): OpenAiTool {
	return {
		type: 'function',
		function: {
			name: definition.name,
			...(definition.description !== undefined && {
				description: definition.description,
			}),
			parameters: toParameters(definition.inputSchema),
		},
	};
}

/**
 * OpenAI requires `function.parameters` to be a JSON Schema object. Default a
 * missing schema to the empty object schema, and default `properties`/`required`
 * on a bare object schema, which some providers reject when absent.
 */
function toParameters(schema: unknown): unknown {
	if (schema === undefined) return { type: 'object', properties: {} };
	if (
		typeof schema !== 'object' ||
		schema === null ||
		(schema as { type?: unknown }).type !== 'object'
	) {
		return schema;
	}
	const object = schema as Record<string, unknown>;
	return {
		...object,
		properties: object.properties ?? {},
		required: object.required ?? [],
	};
}

/** Accumulate one `tool_calls[]` delta into the in-flight calls. */
function accumulateToolCall(
	delta: OpenAiToolCallDelta,
	byIndex: Map<number, PendingToolCall>,
	indexless: PendingToolCall[],
): void {
	const fn = delta.function ?? {};
	if (typeof delta.index !== 'number') {
		// No index: a complete call in one delta (Gemini's compat shape). Its
		// arguments are not fragmented, so it stands alone rather than merging.
		indexless.push({
			id: delta.id ?? '',
			name: fn.name ?? '',
			args: fn.arguments ?? '',
		});
		return;
	}
	const existing = byIndex.get(delta.index);
	if (!existing) {
		byIndex.set(delta.index, {
			id: delta.id ?? '',
			name: fn.name ?? '',
			args: fn.arguments ?? '',
		});
		return;
	}
	if (delta.id) existing.id = delta.id;
	if (fn.name) existing.name = fn.name;
	if (fn.arguments) existing.args += fn.arguments;
}

/** Parse a tool call's accumulated argument string, tolerating a bad value. */
function parseArguments(args: string): JsonValue {
	if (!args) return {};
	try {
		return JSON.parse(args) as JsonValue;
	} catch {
		return {};
	}
}

/** Read a non-2xx response body as the OpenAI error shape into a run-error. */
async function readErrorChunk(response: Response): Promise<EngineChunk> {
	const fallback = `The inference request failed (${response.status}).`;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			type: 'run-error',
			message: fallback,
			code: String(response.status),
		};
	}
	const error = (body as { error?: { message?: string; code?: string | null } })
		.error;
	const message = error?.message ?? fallback;
	const code = error?.code;
	return {
		type: 'run-error',
		message,
		// Preserve the app error code (e.g. `InsufficientCredits`, `Unauthorized`)
		// so the failed turn stays branchable; fall back to the HTTP status.
		code: typeof code === 'string' ? code : String(response.status),
	};
}

/**
 * Parse an OpenAI Chat Completions SSE stream into the loop's
 * {@link EngineChunk} stream. Text deltas pass through live; tool calls are
 * accumulated and emitted as one `tool-call` each once the stream ends, so the
 * loop never reduces fragmented arguments itself.
 */
async function* parseOpenAiStream(
	response: Response,
	signal: AbortSignal,
): AsyncIterable<EngineChunk> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const byIndex = new Map<number, PendingToolCall>();
	const indexless: PendingToolCall[] = [];

	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE lines may end in CRLF as well as LF (servers on sse-starlette
			// default to CRLF), so a blank line is either `\n\n` or `\r\n\r\n`.
			const frames = buffer.split(/\r?\n\r?\n/);
			// The last element is an incomplete frame; keep it for the next read.
			buffer = frames.pop() ?? '';
			for (const frame of frames) {
				const dataLine = frame
					.split(/\r?\n/)
					.find((line) => line.startsWith('data:'));
				if (!dataLine) continue;
				const data = dataLine.slice('data:'.length).trimStart();
				if (data === '' || data === '[DONE]') continue;
				let parsed: OpenAiStreamChunk;
				try {
					parsed = JSON.parse(data) as OpenAiStreamChunk;
				} catch {
					continue; // Skip a frame that is not valid JSON.
				}

				if (parsed.error) {
					yield {
						type: 'run-error',
						message: parsed.error.message ?? 'The model run failed.',
						...(typeof parsed.error.code === 'string' && {
							code: parsed.error.code,
						}),
					};
					continue;
				}

				const choice = parsed.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta;
				if (!delta) continue;

				if (typeof delta.content === 'string' && delta.content.length > 0) {
					yield { type: 'text-delta', delta: delta.content };
				}
				for (const toolDelta of delta.tool_calls ?? []) {
					accumulateToolCall(toolDelta, byIndex, indexless);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Emit accumulated tool calls once the stream ends: index-correlated calls in
	// index order, then the index-less (already-complete) calls.
	const ordered = [...byIndex.entries()]
		.sort((a, b) => a[0] - b[0])
		.map((entry) => entry[1]);
	for (const call of [...ordered, ...indexless]) {
		yield {
			type: 'tool-call',
			toolCallId: call.id,
			toolName: call.name,
			input: parseArguments(call.args),
		};
	}
}

/**
 * Build an OpenAI-compatible {@link AgentEngine} the client agent loop drives.
 * `data()` is read per turn and returns the whole {@link OpenAiTurnContext}: the
 * resolved transport (`fetch` + `baseURL`) plus the model and system prompts. The
 * `fetch` carries auth (the gateway's bearer, a custom backend's key, or none for
 * a local one) and `baseURL` is the inference server, so switching either the
 * backend or the model takes effect on the next turn with no handle rebuild
 * (ADR-0054). The request's `tools` (the live catalog for this step) are mapped to
 * OpenAI tools so the model emits tool calls.
 */
export function createOpenAiAgentEngine({
	data,
}: {
	data: () => OpenAiTurnContext;
}): AgentEngine {
	return async function* (request, signal) {
		const { fetch, baseURL, model, systemPrompts } = data();
		const endpoint = joinUrl(baseURL, 'chat/completions');
		const body = {
			model,
			messages: [
				...systemPrompts.map(
					(content): OpenAiMessage => ({ role: 'system', content }),
				),
				...request.messages.map(toOpenAiMessage),
			],
			...(request.tools.length > 0 && {
				tools: request.tools.map(toOpenAiTool),
			}),
			stream: true,
			stream_options: { include_usage: true },
		};

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'text/event-stream',
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal.aborted) return;
			yield {
				type: 'run-error',
				code: 'stream-error',
				message: extractErrorMessage(error),
			};
			return;
		}

		if (!response.ok) {
			yield await readErrorChunk(response);
			return;
		}
		yield* parseOpenAiStream(response, signal);
	};
}

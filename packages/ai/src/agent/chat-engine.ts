/**
 * The agent loop's engine over `ai.chat`: the loop's transcript and tools go
 * out as an OpenAI chat request, and the streamed chunks come back as the
 * loop's {@link EngineChunk}s, with each tool call reduced from its deltas.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type {
	ChatChunk,
	ChatMessage,
	ChatTool,
	ToolCallDelta,
} from '../client.js';
import type { Ai } from '../open-ai.js';
import type {
	AgentEngine,
	AgentEngineToolDefinition,
	EngineChunk,
	ModelMessage,
} from './engine.js';

/** What one turn sends: through which AI, to which model, under which system prompts. */
export type ChatTurn = {
	ai: Pick<Ai, 'chat'>;
	endpoint: string;
	model: string;
	systemPrompts: string[];
};

/** A tool call accumulated across one or more deltas. */
type PendingToolCall = { id: string; name: string; args: string };

/** Map one transcript message to its OpenAI chat shape. */
function toChatMessage(message: ModelMessage): ChatMessage {
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

/** Map one tool definition to its OpenAI chat shape. */
function toChatTool(definition: AgentEngineToolDefinition): ChatTool {
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
function toParameters(schema: unknown): Record<string, unknown> {
	if (schema === undefined) return { type: 'object', properties: {} };
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
		throw new Error('Tool input schema must be a JSON Schema object.');
	}
	const object = schema as Record<string, unknown>;
	if (object.type !== 'object') return object;
	return {
		...object,
		properties: object.properties ?? {},
		required: object.required ?? [],
	};
}

/** Accumulate one `tool_calls[]` delta into the in-flight calls. */
function accumulateToolCall(
	delta: ToolCallDelta,
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

type FinishReason = ChatChunk['choices'][number]['finish_reason'];

/**
 * Why a stream that ended without a transport error is still not a whole
 * answer, or `undefined` when it is one.
 *
 * `stop` and `tool_calls` are the two finishes that complete an answer. `stop`
 * may carry tool calls: Gemini's compat endpoint finishes `stop` while calling
 * tools. Everything else is cut short or unreadable, so its text is not saved
 * and its accumulated calls never run.
 */
function incompleteFinish(
	reason: FinishReason,
	callCount: number,
): { message: string; code: string } | undefined {
	switch (reason) {
		case 'stop':
			return undefined;
		case 'tool_calls':
			return callCount > 0
				? undefined
				: {
						message: 'The model announced tool calls and sent none.',
						code: 'incomplete-stream',
					};
		case 'length':
			return {
				message: 'The model reached its output limit before finishing.',
				code: 'length',
			};
		case 'content_filter':
			return {
				message: 'The provider withheld part of the answer.',
				code: 'content_filter',
			};
		case 'function_call':
			return {
				message: 'The model used a legacy function call, which is not read.',
				code: 'function_call',
			};
		case null:
		case undefined:
			return {
				message: 'The model stream ended before the answer finished.',
				code: 'incomplete-stream',
			};
		default:
			// A reason outside OpenAI's vocabulary. Its meaning is unknown, so the
			// answer is not treated as whole.
			return {
				message: `The model stopped for an unrecognized reason: ${reason}`,
				code: 'incomplete-stream',
			};
	}
}

/**
 * An agent engine that sends each step through `turn().ai.chat`. `turn` is
 * read once per step, so a host captures its choice of model when a turn
 * starts. The loop stays the tool executor: this only reduces the model's
 * tool calls and reports whether its answer finished.
 */
export function createChatEngine({
	turn,
}: {
	turn: () => ChatTurn;
}): AgentEngine {
	return async function* (request, signal): AsyncGenerator<EngineChunk> {
		const byIndex = new Map<number, PendingToolCall>();
		const indexless: PendingToolCall[] = [];
		let finishReason: FinishReason = undefined;
		let stream: ReturnType<Ai['chat']>;
		try {
			const { ai, endpoint, model, systemPrompts } = turn();
			stream = ai.chat(
				{
					endpoint,
					model,
					messages: [
						...systemPrompts.map(
							(content): ChatMessage => ({ role: 'system', content }),
						),
						...request.messages.map(toChatMessage),
					],
					...(request.tools.length > 0 && {
						tools: request.tools.map(toChatTool),
					}),
				},
				{ signal },
			);
		} catch (cause) {
			// No model chosen, or a tool schema that is not one: the turn fails.
			yield {
				type: 'run-error',
				message: extractErrorMessage(cause),
				code: 'stream-error',
			};
			return;
		}
		for await (const { data: chunk, error } of stream) {
			if (signal.aborted) return;
			if (error !== null) {
				if (error.name === 'Cancelled') return;
				yield {
					type: 'run-error',
					message: error.message,
					code:
						('code' in error ? error.code : undefined) ??
						('status' in error ? String(error.status) : 'stream-error'),
				};
				return;
			}
			// A usage-only frame has no choice and says nothing about the finish.
			const choice = chunk.choices[0];
			if (!choice) continue;
			if (choice.finish_reason != null) finishReason = choice.finish_reason;
			const delta = choice.delta;
			if (!delta) continue;
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				yield { type: 'text-delta', delta: delta.content };
			}
			for (const call of delta.tool_calls ?? [])
				accumulateToolCall(call, byIndex, indexless);
		}
		if (signal.aborted) return;
		// Failed, cancelled, or cut-short streams never execute their partially
		// accumulated calls.
		const ordered = [...byIndex.entries()]
			.sort((a, b) => a[0] - b[0])
			.map((entry) => entry[1]);
		const incomplete = incompleteFinish(
			finishReason,
			ordered.length + indexless.length,
		);
		if (incomplete) {
			yield { type: 'run-error', ...incomplete };
			return;
		}
		for (const call of [...ordered, ...indexless]) {
			yield {
				type: 'tool-call',
				toolCallId: call.id,
				toolName: call.name,
				input: parseArguments(call.args),
			};
		}
	};
}

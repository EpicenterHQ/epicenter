/** Adapts an SDK Chat Completions stream to the existing agent loop. */

import OpenAI from 'openai';
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type {
	AgentEngine,
	AgentEngineToolDefinition,
	ModelMessage,
} from '@epicenter/agent-protocol';

/** Captured client and prompts for one turn; the loop remains the tool executor. */
export type OpenAiTurnContext = {
	client: OpenAI;
	model: string;
	systemPrompts: string[];
};

// Compatible providers may omit index for complete parallel tool calls.
type OpenAiToolCallDelta =
	Partial<OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall>;

/** A tool call accumulated across one or more deltas. */
type PendingToolCall = { id: string; name: string; args: string };

/** Map one transcript message to its OpenAI Chat Completions shape. */
function toOpenAiMessage(
	message: ModelMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
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
function toOpenAiTool(
	definition: AgentEngineToolDefinition,
): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
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

/** Use SDK framing and cancellation while retaining the agent's tool-call reducer. */
export function createOpenAiAgentEngine({
	data,
}: {
	data: () => OpenAiTurnContext;
}): AgentEngine {
	return async function* (request, signal) {
		const byIndex = new Map<number, PendingToolCall>();
		const indexless: PendingToolCall[] = [];
		try {
			const { client, model, systemPrompts } = data();
			const stream = await client.chat.completions.create(
				{
					model,
					messages: [
						...systemPrompts.map(
							(
								content,
							): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
								role: 'system',
								content,
							}),
						),
						...request.messages.map(toOpenAiMessage),
					],
					...(request.tools.length > 0 && {
						tools: request.tools.map(toOpenAiTool),
					}),
					stream: true,
					stream_options: { include_usage: true },
				},
				{ signal, maxRetries: 0 },
			);
			for await (const chunk of stream) {
				if (signal.aborted) return;
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) continue;
				if (typeof delta.content === 'string' && delta.content.length > 0) {
					yield { type: 'text-delta', delta: delta.content };
				}
				for (const call of delta.tool_calls ?? [])
					accumulateToolCall(call, byIndex, indexless);
			}
		} catch (error) {
			if (signal.aborted) return;
			const apiError = error instanceof OpenAI.APIError ? error : undefined;
			const payload = apiError?.error;
			const message =
				payload && 'message' in payload && typeof payload.message === 'string'
					? payload.message
					: extractErrorMessage(error);
			yield {
				type: 'run-error',
				message,
				code:
					apiError?.code ??
					(apiError?.status === undefined
						? 'stream-error'
						: String(apiError.status)),
			};
			return;
		}
		if (signal.aborted) return;
		// Failed or cancelled streams never execute their partially accumulated calls.
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
	};
}

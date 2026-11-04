/**
 * The agent's tools are values: an array of `{ name, description, input,
 * mutates?, run }`. A tool the host leaves out of the array is denied: the
 * model is never offered it, and a call naming it runs nothing. A tool that
 * `mutates` runs only once the host's `approve` answers yes.
 */
import type { JsonValue } from 'wellcrafted/json';
import type { ChatTool } from '../client.js';

/** What a tool answers: its content for the model, details for the person, and whether it failed. */
export type AgentToolOutcome = {
	content: string;
	details?: JsonValue;
	isError: boolean;
};

/** One call the model asked for. */
export type AgentToolCall = {
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

/** One tool the model may call. */
export type AgentTool = {
	name: string;
	/** What the model reads to decide when to call it. */
	description?: string;
	/** The JSON Schema object of its input; none takes no input. */
	input?: { readonly [key: string]: JsonValue };
	/** Whether it changes anything: then it runs only once `approve` answers yes. */
	mutates?: boolean;
	/** Run the call. A rejection ends the turn, as a failed stream does. */
	run(
		input: JsonValue,
		options: { signal: AbortSignal },
	): Promise<AgentToolOutcome>;
};

/** Ask the person whether a tool that `mutates` may run this call. */
export type Approve = (
	call: AgentToolCall,
	tool: AgentTool,
) => Promise<boolean>;

/**
 * Run `call` with the tool of its name among `tools`. A name not offered
 * runs nothing. A tool that mutates asks `approve` first, and with no
 * `approve` it is refused, so nothing changes without the person's yes.
 */
export async function runTool({
	tools,
	approve,
	call,
	signal,
}: {
	tools: readonly AgentTool[];
	approve: Approve | undefined;
	call: AgentToolCall;
	signal: AbortSignal;
}): Promise<AgentToolOutcome> {
	const tool = tools.find((candidate) => candidate.name === call.toolName);
	if (!tool)
		return {
			content: `No tool named ${call.toolName} is available.`,
			isError: true,
		};
	if (tool.mutates) {
		if (!approve)
			return {
				content: 'Not run: nothing asks the person to approve a change.',
				isError: true,
			};
		const approved = await approve(call, tool);
		if (signal.aborted)
			return { content: 'Stopped before the tool ran.', isError: true };
		if (!approved) return { content: 'Denied by the user.', isError: true };
	}
	return tool.run(call.input, { signal });
}

/**
 * The tools offered to the model, as OpenAI tool definitions.
 *
 * OpenAI requires `function.parameters` to be a JSON Schema object. A
 * missing schema becomes the empty object schema, and a bare object schema
 * gains `properties` and `required`, which some providers reject when
 * absent. A schema that is not an object throws, which fails the turn.
 */
export function toChatTools(tools: readonly AgentTool[]): ChatTool[] {
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			...(tool.description !== undefined && {
				description: tool.description,
			}),
			parameters: toParameters(tool.input),
		},
	}));
}

function toParameters(schema: JsonValue | undefined): Record<string, unknown> {
	if (schema === undefined) return { type: 'object', properties: {} };
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
		throw new Error('Tool input schema must be a JSON Schema object.');
	}
	if (schema.type !== 'object') return schema;
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}

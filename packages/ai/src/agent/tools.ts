import type { JsonValue } from 'wellcrafted/json';
import type { ChatTool } from '../client.js';

export type AgentToolDefinition = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: JsonValue;
	kind: 'query' | 'mutation';
};

export type AgentToolCall = {
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

export type AgentToolOutcome = {
	content: string;
	details?: JsonValue;
	isError: boolean;
};

/** A live catalog injected by the host. */
export type ToolCatalog = {
	definitions(): AgentToolDefinition[];
	resolve(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolOutcome>;
};

export type ApprovalDecision = 'auto' | 'ask' | 'deny';

export type Approval = {
	decide(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): ApprovalDecision;
	request(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): Promise<boolean>;
};

export async function resolveApprovedToolCall({
	tools,
	approval,
	call,
	signal,
}: {
	tools: ToolCatalog;
	approval: Approval;
	call: AgentToolCall;
	signal: AbortSignal;
}): Promise<AgentToolOutcome> {
	const definition = tools
		.definitions()
		.find((candidate) => candidate.name === call.toolName);
	if (!definition) {
		return {
			content: `No tool named ${call.toolName} is available.`,
			isError: true,
		};
	}

	const decision = approval.decide(call, definition);
	if (decision === 'deny') {
		return { content: 'Denied by policy.', isError: true };
	}
	if (decision === 'ask') {
		const approved = await approval.request(call, definition);
		if (signal.aborted) {
			return { content: 'Stopped before the tool ran.', isError: true };
		}
		if (!approved) return { content: 'Denied by the user.', isError: true };
	}

	return tools.resolve(call, signal);
}

export const NO_TOOLS: ToolCatalog = {
	definitions: () => [],
	resolve: async (call) => ({
		content: `No tool named ${call.toolName} is available.`,
		isError: true,
	}),
};

export function defaultApprovalDecision(
	_call: AgentToolCall,
	definition: AgentToolDefinition,
): ApprovalDecision {
	return definition.kind === 'mutation' ? 'ask' : 'auto';
}

/**
 * The tools offered to the model, as OpenAI tool definitions. `kind` and
 * `title` are the loop's and never reach the model.
 *
 * OpenAI requires `function.parameters` to be a JSON Schema object. A missing
 * schema becomes the empty object schema, and a bare object schema gains
 * `properties` and `required`, which some providers reject when absent. A
 * schema that is not an object throws, which fails the turn.
 */
export function toChatTools(definitions: AgentToolDefinition[]): ChatTool[] {
	return definitions.map((definition) => ({
		type: 'function',
		function: {
			name: definition.name,
			...(definition.description !== undefined && {
				description: definition.description,
			}),
			parameters: toParameters(definition.inputSchema),
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

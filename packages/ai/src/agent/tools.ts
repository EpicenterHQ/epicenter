import type { JsonValue } from 'wellcrafted/json';

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

/**
 * A read-only local source the Home host can read on this machine and
 * offer as one verb (ADR-0115). The desktop composes a source it owns
 * locally (iMessage in the design memo; an injected reader here) into the same
 * {@link ToolCatalog} the agent loop already consumes, so a chat turn can ask a
 * question that reads it and the answer streams back to every attached client.
 *
 * ## The source stays host-owned
 *
 * The source is never reachable as a relay route or capability (ADR-0080
 * decision 2): a remote client sends only a host-owned session command, the host
 * reads the local source, and the tool result rides back inside the host-owned
 * session (ADR-0115). There is no per-app endpoint, no route, and no MCP surface
 * over the wire; the source is one local verb behind the same seam as the
 * in-process apps.
 *
 * ## Read-only means a query that writes nothing
 *
 * The verb is a `query`: it runs unattended (no mutation approval, ADR-0044) and
 * writes to no record table. The rows it reads never become Epicenter records.
 * They enter the transcript only as the model-facing text of one tool result,
 * exactly like any other tool's output, so the durable transcript is the only
 * place source content lands, and only as chat history, never as a source table.
 *
 * ## Injected reader, so the fixture is not baked into production
 *
 * The reader is injected the way the boxed-app spawn command is (`localBooks`):
 * a test passes a fixture, and a later real host passes a Messages reader,
 * without this module or the host learning which, so the source-plane behavior
 * is exercised end to end without scraping Messages.app.
 */

import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/agent';

/** One message a local source read returns: who sent it, its text, and when. */
export type LocalSourceMessage = {
	from: string;
	text: string;
	at: string;
};

export type LocalSourceCatalogOptions = {
	/**
	 * Read the local source for messages matching `query`. Injected so a test
	 * backs it with a fixture and a real host backs it with a Messages reader; the
	 * host and this module never learn which. Read-only by contract: it must not
	 * mutate the source, and its result is model-facing text only.
	 */
	search: (
		query: string,
	) => LocalSourceMessage[] | Promise<LocalSourceMessage[]>;
};

/** The one tool this catalog exposes; namespaced to `imessage__search` by the host. */
const SEARCH_TOOL: AgentToolDefinition = {
	name: 'search',
	kind: 'query',
	title: 'Search Messages',
	description:
		'Search recent local messages for text matching the query. Read-only.',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Text to match against recent messages.',
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
};

/**
 * Build a {@link ToolCatalog} of exactly one read-only source verb over the
 * injected reader. `definitions` lists the fixed `search` tool; `resolve` runs
 * the reader and returns its matches as the model-facing tool result.
 */
export function createLocalSourceCatalog(
	options: LocalSourceCatalogOptions,
): ToolCatalog {
	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		if (call.toolName !== SEARCH_TOOL.name) {
			return {
				content: `No source tool named "${call.toolName}".`,
				isError: true,
			};
		}
		const query = readQuery(call.input);
		if (query === undefined) {
			return { content: 'A "query" string is required.', isError: true };
		}
		const matches = await options.search(query);
		return {
			content: formatMatches(query, matches),
			details: matches,
			isError: false,
		};
	}

	return {
		definitions: () => [SEARCH_TOOL],
		resolve,
	};
}

/** Pull the `query` string from a tool call's parsed input, or nothing. */
function readQuery(input: AgentToolCall['input']): string | undefined {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const query = (input as Record<string, unknown>).query;
	return typeof query === 'string' ? query : undefined;
}

/** Render matches as the model-facing tool-result text. */
function formatMatches(query: string, matches: LocalSourceMessage[]): string {
	if (matches.length === 0) return `No messages match "${query}".`;
	const lines = matches.map(
		(message) => `${message.at} ${message.from}: ${message.text}`,
	);
	return `${matches.length} message(s) matching "${query}":\n${lines.join('\n')}`;
}

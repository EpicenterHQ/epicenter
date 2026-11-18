/**
 * MCP tools for `epicenter serve` (ADR-0849, ADR-0853): every app's actions,
 * and nothing else. An action that declares `mcp: false` is not offered:
 * `tools/list` leaves it out and `tools/call` refuses its name.
 *
 * Each request loads the apps it needs as they are on disk now (`home.ts`),
 * so an edit between two calls is seen by the second. `tools/list` offers
 * each app's actions; an app that cannot load loses only its own tools, and
 * why goes to stderr. `tools/call` decodes the tool name and runs the action
 * in this process (`run.ts`), which checks the app, the action, and the
 * input, and leaves the call's writes pending.
 * A call's result is the same `{ data, error }` `--json` prints, as
 * `structuredContent`, with `isError` for any error. An action's updates are not sent:
 * an MCP client reads only the answer.
 */

import { ActionError, type Answer } from '@epicenter/app';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './engines.ts';
import { homeEntries, loadHomeApp } from './home.ts';
import { actionTool } from './listing.ts';
import { outcome, writeErr } from './output.ts';
import { rootInstructions } from './root.ts';
import { resolveAction, runAction } from './run.ts';

/** One app's tools; none when it cannot load, and why goes to stderr. */
async function appTools(entry: string): Promise<Tool[]> {
	const { data: located, error } = await loadHomeApp(entry);
	if (error) {
		writeErr(
			error.cause === 'app-problems'
				? error.message
				: `${entry}: ${error.message}`,
		);
		return [];
	}
	return Object.entries(located.actions)
		.filter(([, action]) => action.mcp !== false)
		.map(([key, action]) => actionTool(located.name, key, action));
}

/**
 * An answer as an MCP result: the same value `--json` prints, as
 * `structuredContent`, and `isError` for any error. A failure's text is what
 * a person would read on stderr.
 */
function toolResult(answer: Answer) {
	const structuredContent = answer as Record<string, unknown>;
	const result = outcome(answer);
	if (result.code === 0)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
			structuredContent,
		};
	return {
		isError: true,
		content: [{ type: 'text' as const, text: result.stderr.trim() }],
		structuredContent,
	};
}

/**
 * Register the tool handlers on a fresh MCP server. It reads the
 * Epicenter's `AGENTS.md` now, so each initialize sends what the file says
 * then (ADR-0878).
 */
export async function createMcpServer() {
	const instructions = await rootInstructions();
	const server = new Server(
		{ name: 'epicenter', version: VERSION },
		{
			capabilities: { tools: {} },
			...(instructions === undefined ? {} : { instructions }),
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const listed = await Promise.all(
			(await homeEntries()).map(({ entry }) => appTools(entry)),
		);
		return { tools: listed.flat() };
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const [app = '', ...words] = name.split('_');
		// App names and action words have no underscores.
		const key = words.join(' ');
		const call = await resolveAction(app, key, args ?? {});
		if (call.refusal) return toolResult(call.refusal);
		if (call.action.mcp === false)
			return toolResult(
				ActionError.NotStarted({
					cause: 'usage',
					message: `${app} ${key} is not offered over MCP`,
				}),
			);
		return toolResult(
			await runAction(call.located, key, call.action, call.input),
		);
	});
	return server;
}

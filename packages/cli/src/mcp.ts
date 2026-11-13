/**
 * MCP tools for `epicenter serve` (ADR-0849, ADR-0853): every app's actions,
 * and nothing else.
 *
 * Each request loads the apps it needs as they are on disk now (`home.ts`),
 * so an edit between two calls is seen by the second. `tools/list` offers
 * each app's actions; an app that cannot load loses only its own tools, and
 * why goes to stderr. `tools/call` decodes the tool name and runs the action
 * in this process (`run.ts`), which checks the app, the action, and the
 * input, and commits what the call wrote before it answers. A call's result
 * is the same object `--json` prints: `structuredContent` on success, and
 * with `isError` on failure. What an action yields is not sent: an MCP
 * client reads only the answer.
 */

import { isName } from '@epicenter/app';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { nameProblem } from './commands.ts';
import { VERSION } from './engines.ts';
import { homeEntries, loadHomeApp } from './home.ts';
import { actionTool } from './listing.ts';
import { type Answer, renderAnswer, writeErr } from './output.ts';
import { rootInstructions } from './root.ts';
import { callAction } from './run.ts';

/** The tools the Epicenter offers now. */
async function listTools(): Promise<Tool[]> {
	const listed = await Promise.all(
		(await homeEntries()).map(({ entry }) => appTools(entry)),
	);
	return listed.flat();
}

/** One app's tools; none when it cannot load, and why goes to stderr. */
async function appTools(entry: string): Promise<Tool[]> {
	const { data: located, error } = await loadHomeApp(entry);
	if (error) {
		writeErr(`${entry}: ${error.message}`);
		return [];
	}
	if (!located.ok) {
		writeErr(`${entry}: ${located.problems.join('; ')}`);
		return [];
	}
	return Object.entries(located.actions).map(([key, action]) =>
		actionTool(located.name, key, action),
	);
}

/**
 * An answer as an MCP result: the same value `--json` prints, as
 * `structuredContent`, and `isError` exactly when the action threw or did not
 * run. A failure's text is what a person would read on stderr.
 */
function toolResult(answer: Answer) {
	const structuredContent = answer as Record<string, unknown>;
	const { code, stderr } = renderAnswer(answer);
	if (code === 0)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
			structuredContent,
		};
	return {
		isError: true,
		content: [{ type: 'text' as const, text: stderr.trim() }],
		structuredContent,
	};
}

/**
 * Run the action `<app>_<word>_<word>` names. App names and action words hold
 * no underscores, and the first word must be able to name an app, so a tool
 * name never runs one of `epicenter`'s own commands.
 */
async function callTool(name: string, args: Record<string, unknown>) {
	const [app = '', ...words] = name.split('_');
	if (
		nameProblem(app) !== undefined ||
		words.length === 0 ||
		!words.every(isName)
	)
		return toolResult({
			error: { name: 'Usage', message: `Unknown tool ${name}` },
		});
	return toolResult(await callAction(app, words.join(' '), args));
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
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: await listTools(),
	}));
	server.setRequestHandler(CallToolRequestSchema, (request) =>
		callTool(request.params.name, request.params.arguments ?? {}),
	);
	return server;
}

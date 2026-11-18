/**
 * MCP tools for `epicenter serve` (ADR-0849, ADR-0853): every app's actions,
 * and nothing else. An action that declares `mcp: false` is not offered:
 * `tools/list` leaves it out and `tools/call` refuses its name before it
 * reads the input, so the refusal tells an agent nothing more.
 *
 * Each request loads the apps it needs as they are on disk now (`apps.ts`),
 * so an edit between two calls is seen by the second. `tools/list` offers
 * the actions in serve's one listing (`listing.ts`); an app that cannot load
 * loses only its own tools, and why goes to stderr. `tools/call` decodes the
 * tool name and runs the action in this process (`run.ts`), which checks the
 * app, the action, and the input, and leaves the call's writes pending.
 * A call's result is the same `{ data, error }` `--json` prints, as
 * `structuredContent`, with `isError` for any error. An action's updates are not sent:
 * an MCP client reads only the answer.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Err } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { ActionError, type Answer } from '../index.ts';
import { fromToolName, listApps } from './listing.ts';
import { outcome, writeErr } from './output.ts';
import { type EpicenterRoot, rootInstructions } from './root.ts';
import { checkCall, findAction, runAction } from './run.ts';

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
export async function createMcpServer(root: Pick<EpicenterRoot, 'folder'>) {
	const instructions = await rootInstructions(root);
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{
			capabilities: { tools: {} },
			...(instructions === undefined ? {} : { instructions }),
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const listing = await listApps(root);
		const loaded = new Set(listing.apps.map(({ name }) => name));
		for (const { entry, problems } of listing.problems)
			if (!loaded.has(entry)) writeErr(`${entry}: ${problems.join('; ')}`);
		return {
			tools: listing.apps.flatMap(({ actions }) =>
				actions.filter((tool) => tool.mcp !== false),
			),
		};
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const { app, key } = fromToolName(name);
		const { data: found, error } = await findAction(root, app, key);
		if (error) return toolResult(Err(error));
		if (found.action.mcp === false)
			return toolResult(
				ActionError.NotStarted({
					cause: 'usage',
					message: `${app} ${key} is not offered over MCP`,
				}),
			);
		const { data: call, error: misfit } = checkCall(found, args ?? {});
		if (misfit) return toolResult(Err(misfit));
		return toolResult(await runAction(call));
	});
	return server;
}

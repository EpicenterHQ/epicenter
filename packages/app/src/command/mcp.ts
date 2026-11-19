/**
 * MCP tools for `epicenter serve` (ADR-0849, ADR-0853): every app's actions,
 * and nothing else. An action that declares `mcp: false` is not offered:
 * `tools/list` leaves it out and `tools/call` refuses its name before it
 * reads the input, so the refusal tells an agent nothing more.
 *
 * Serve loads its apps and reads the Epicenter's `AGENTS.md` once, when it
 * starts (ADR-0959), so every request answers from the same apps and the
 * same instructions until serve restarts. `tools/list` offers the actions
 * of serve's listing; an app that did not load offers none. `tools/call`
 * decodes the tool name and runs the action in this process (`run.ts`),
 * which checks the app, the action, and the input. A call's result is the
 * same `{ data, error }` `--json` prints, as `structuredContent`, with
 * `isError` for any error. An action's updates are not sent: an MCP client
 * reads only the answer.
 *
 * The SDK's `Server` holds one transport at a time, and a stateless
 * transport takes one request, so each request gets its own of both; they
 * read the tools and instructions serve already holds.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Err } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { ActionError, type Answer } from '../index.ts';
import type { Apps } from './apps.ts';
import { outcome } from './output.ts';
import { fromToolName, type Listing } from './protocol.ts';
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

/** An MCP server for one request, answering from what serve loaded. */
export function createMcpServer({
	apps,
	listing,
	instructions,
}: {
	apps: Apps;
	listing: Pick<Listing, 'apps'>;
	/** The Epicenter's `AGENTS.md`, sent at initialize (ADR-0878). */
	instructions: string | undefined;
}) {
	// Every action not marked `mcp: false`: the only names a tool call may use.
	const tools = listing.apps.flatMap(({ actions }) =>
		actions.filter((tool) => tool.mcp !== false),
	);
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{
			capabilities: { tools: {} },
			...(instructions === undefined ? {} : { instructions }),
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		if (!tools.some((tool) => tool.name === name))
			return toolResult(
				ActionError.NotStarted({
					message: `No tool ${JSON.stringify(name)}; tools/list names them`,
				}),
			);
		const { app, action } = fromToolName(name);
		const { data: found, error } = findAction(apps, app, action);
		if (error) return toolResult(Err(error));
		const { data: call, error: misfit } = checkCall(found, {
			value: args ?? {},
		});
		if (misfit) return toolResult(Err(misfit));
		return toolResult(await runAction(call));
	});
	return server;
}

/**
 * MCP for `epicenter serve`, at `POST /`: one tool per action, named
 * `<app>_<action>`, and nothing else. `tools/call` runs the action in serve
 * as the command's call does, and answers `{ data, error }` as
 * `structuredContent`, with `isError` for any error. Updates are not sent:
 * an MCP client reads only the answer.
 *
 * The SDK's `Server` holds one transport at a time, and a stateless
 * transport takes one request, so each request gets its own of both.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Err } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import type { Answer } from '../answer.ts';
import { ActionError } from '../errors.ts';
import type { Loaded } from './load.ts';
import { errorText } from './output.ts';
import { checkCall, type Found, runAction } from './run.ts';

/** An answer as an MCP tool result. A failure's text is what the command prints on stderr. */
function toolResult(answer: Answer) {
	const structuredContent = answer as Record<string, unknown>;
	if (answer.error === null)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
			structuredContent,
		};
	return {
		isError: true,
		content: [{ type: 'text' as const, text: errorText(answer.error) }],
		structuredContent,
	};
}

/**
 * MCP for what serve loaded: the tools are made once, and each request gets
 * its own server and transport. A tool is named `<app>_<action>`; a name has
 * no underscore, so each tool names one action.
 */
export function createMcp(loaded: Loaded) {
	const actions = new Map<string, Found>();
	for (const [app, { actions: ofApp }] of Object.entries(
		loaded.epicenter?.apps ?? {},
	))
		for (const [action, run] of Object.entries(ofApp))
			actions.set(`${app}_${action}`, { app, action, run });
	const tools = [...actions].map(([name, { run }]) => ({
		name,
		description: run.description,
		inputSchema: run.input,
	}));
	return async (request: Request) => {
		const server = new Server(
			{ name: 'epicenter', version: packageJson.version },
			{
				capabilities: { tools: {} },
				...(loaded.instructions === undefined
					? {}
					: { instructions: loaded.instructions }),
			},
		);
		server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
		server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
			const found = actions.get(params.name);
			if (!found)
				return toolResult(
					ActionError.NotStarted({
						message:
							loaded.problem ??
							`No tool ${JSON.stringify(params.name)}; tools/list names them`,
					}),
				);
			const { data: call, error: misfit } = checkCall(found, {
				value: params.arguments ?? {},
			});
			if (misfit) return toolResult(Err(misfit));
			return toolResult(await runAction(call));
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		try {
			await server.connect(transport);
			return await transport.handleRequest(request);
		} finally {
			await server.close();
		}
	};
}

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
import { ActionError } from '../errors.ts';
import type { Answer } from '../result.ts';
import { type Loaded, listingOf } from './load.ts';
import { errorText } from './output.ts';
import { fromToolName, toolName } from './protocol.ts';
import { checkCall, findAction, runAction } from './run.ts';

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

/** Answer one MCP request from what serve loaded. */
export async function answerMcp(loaded: Loaded, request: Request) {
	const tools = listingOf(loaded).apps.flatMap((app) =>
		app.actions.map((action) => ({
			name: toolName(app.name, action.name),
			description: action.description,
			inputSchema: action.input,
		})),
	);
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
		if (!tools.some((tool) => tool.name === params.name))
			return toolResult(
				ActionError.NotStarted({
					message: `No tool ${JSON.stringify(params.name)}; tools/list names them`,
				}),
			);
		const { app, action } = fromToolName(params.name);
		const { data: found, error } = findAction(loaded, app, action);
		if (error) return toolResult(Err(error));
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
}

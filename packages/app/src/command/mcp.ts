/**
 * MCP for `epicenter serve`, at `POST /`: one tool per action, named
 * `<app>_<action>`, and nothing else. Serve hands it the program without
 * actions marked `mcp: false`, so here they are neither listed nor found.
 * `tools/call` runs the action in serve as the command's call does, and
 * answers `{ data, error }` as `structuredContent`, with `isError` for any
 * error. Updates are not sent: an MCP client reads only the answer.
 *
 * The SDK's `Server` holds one transport at a time, and a stateless
 * transport takes one request, so each request gets its own of both.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { extractErrorMessage } from 'wellcrafted/error';
import { ActionError, type Answer } from '../answer.ts';
import type { Listing } from '../call.ts';
import { errorText } from './output.ts';
import type { Program } from './program.ts';
import { answerCall } from './run.ts';

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
 * MCP for the program serve loaded, from its listing: the tools are made
 * once, and each request gets its own server and transport. A tool is named
 * `<app>_<action>`; a name has no underscore, so an app's name is the
 * part before the first one.
 */
export function createMcp(program: Program, listing: Listing) {
	const tools = listing.apps.flatMap((app) =>
		app.actions.map((action) => ({
			name: `${app.name}_${action.name}`,
			description: action.description,
			inputSchema: action.input,
		})),
	);
	return async (request: Request) => {
		const server = new Server(
			{ name: 'epicenter', version: listing.version },
			{ capabilities: { tools: {} } },
		);
		// A program that did not load has no tools; say why rather than list none.
		server.setRequestHandler(ListToolsRequestSchema, () => {
			if (program.problem)
				throw new McpError(
					ErrorCode.InternalError,
					`${program.problem}\nFix it, then restart serve.`,
				);
			return { tools };
		});
		server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
			const [app = '', ...action] = params.name.split('_');
			// As on the route, a throw that escapes the call is still an answer
			// rather than a protocol error.
			const answer = await answerCall(
				program,
				app,
				action.join('_'),
				params.arguments ?? {},
				undefined,
				extra.signal,
			).catch((cause: unknown) =>
				ActionError.Threw({ message: extractErrorMessage(cause) }),
			);
			return toolResult(answer);
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

/**
 * Shared MCP tools for `epicenter serve` over HTTP and stdio (ADR-0849,
 * ADR-0853): every app's actions, and nothing else.
 *
 * The server never imports an app. `tools/list` runs `epicenter <app> --json`
 * for each app entry and offers the actions each lists; `tools/call` decodes
 * the tool name and runs `epicenter <app> <words> --input <json>` in a fresh
 * process, which checks the app, the action, and the input. So the
 * code and declaration on disk when a call arrives are what runs, an edit
 * between two calls is seen by the second, and a call's result is the same
 * object `--json` prints: `structuredContent` on success, and with
 * `isError` on failure. The call's process commits the paths it wrote,
 * named for it, before it answers (ADR-0850, `run.ts`). Diagnostics go to
 * stderr.
 */

import { isName } from '@epicenter/app';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../package.json' with { type: 'json' };
import { runChild } from './child.ts';
import { homeEntries } from './home.ts';
import { type Answer, renderAnswer, writeErr } from './output.ts';
import { rootInstructions } from './root.ts';

/**
 * The tools the Epicenter offers now. Each entry is listed by its own child, so an
 * app that fails to import, or prints while importing, loses only its own
 * tools; why is written to stderr.
 */
async function listTools(): Promise<Tool[]> {
	const listed = await Promise.all(
		(await homeEntries()).map(async ({ entry }) => {
			const answer = await runChild([entry, '--json'], 'ignore');
			const value = answer as { actions?: Tool[]; error?: { message: string } };
			if (value.actions) return value.actions;
			writeErr(`${entry}: ${value.error?.message ?? JSON.stringify(answer)}`);
			return [];
		}),
	);
	return listed.flat();
}

/**
 * A child's answer as an MCP result: the same value `--json` prints, as
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
 * Run the action `<app>_<word>_<word>` names in a child, as the command line
 * does; the child commits what it wrote. App names and action words hold no
 * underscores.
 */
async function callTool(name: string, args: Record<string, unknown>) {
	const [app = '', ...words] = name.split('_');
	if (!isName(app) || words.length === 0 || !words.every(isName))
		return toolResult({
			error: { name: 'Usage', message: `Unknown tool ${name}` },
		});
	return toolResult(
		(await runChild(
			[app, ...words, '--input', JSON.stringify(args), '--json'],
			'ignore',
		)) as Answer,
	);
}

/** Register the shared tool handlers on a fresh MCP server. */
export function createMcpServer(instructions?: string) {
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
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

/** Serve every healthy app in the Epicenter until the client ends stdin. */
export async function serveStdio(): Promise<number> {
	const server = createMcpServer(await rootInstructions());
	const transport = new StdioServerTransport();
	const { promise: closed, resolve: closeNow } = Promise.withResolvers<void>();
	server.onclose = closeNow;
	// The SDK's stdio transport does not close itself when stdin ends.
	process.stdin.once('end', closeNow);
	try {
		await server.connect(transport);
		writeErr('Serving your apps over MCP.');
		await closed;
		return 0;
	} finally {
		process.stdin.off('end', closeNow);
		await server.close();
	}
}

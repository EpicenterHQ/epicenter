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
 *
 * A call whose `_meta` sets `epicenter/yields` and gives a `progressToken`
 * (the view client's, ADR-0879) is also sent each value its action yields,
 * as a progress notification with the value in `_meta["epicenter/yield"]`.
 * No other call is; a connector gets only the result.
 */

import { isName } from '@epicenter/app';
import { YIELD_META, YIELDS_META } from '@epicenter/app/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../package.json' with { type: 'json' };
import { runChild } from './child.ts';
import { nameProblem } from './commands.ts';
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
		(await homeEntries()).map(({ entry }) => appTools(entry)),
	);
	return listed.flat();
}

/** One app's tools, as its own child lists them; none when it cannot load, and why goes to stderr. */
async function appTools(entry: string): Promise<Tool[]> {
	const answer = await runChild([entry, '--json'], 'ignore');
	const value = answer as { actions?: Tool[]; error?: { message: string } };
	if (value.actions) return value.actions;
	writeErr(`${entry}: ${value.error?.message ?? JSON.stringify(answer)}`);
	return [];
}

/** Whether a tool says it changes nothing (`readOnlyHint`): all the `read` scope may list and call. */
const isReadOnly = (tool: Tool) => tool.annotations?.readOnlyHint === true;

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
 * underscores, and the first word must be able to name an app, so a tool name
 * never runs one of `epicenter`'s own commands. With `readOnly`, the child
 * runs the action only when it is read-only. With `onYield`, its yields go
 * there, and `signal` stops the child.
 */
async function callTool(
	name: string,
	args: Record<string, unknown>,
	{
		readOnly,
		onYield,
		signal,
	}: {
		readOnly: boolean;
		onYield?: (value: unknown) => unknown;
		signal?: AbortSignal;
	},
) {
	const [app = '', ...words] = name.split('_');
	if (
		nameProblem(app) !== undefined ||
		words.length === 0 ||
		!words.every(isName)
	)
		return toolResult({
			error: { name: 'Usage', message: `Unknown tool ${name}` },
		});
	return toolResult(
		(await runChild(
			[app, ...words, '--input', JSON.stringify(args), '--json'],
			'ignore',
			{ readOnly, onYield, signal },
		)) as Answer,
	);
}

/**
 * Register the shared tool handlers on a fresh MCP server. It reads the
 * Epicenter's `AGENTS.md` now, so each initialize sends what the file says
 * then (ADR-0878). With `readOnly`, for a connector with only the `read`
 * scope (ADR-0871), it lists and runs only read-only actions.
 */
export async function createMcpServer({
	readOnly = false,
}: { readOnly?: boolean } = {}) {
	const instructions = await rootInstructions();
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{
			capabilities: { tools: {} },
			...(instructions === undefined ? {} : { instructions }),
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools = await listTools();
		return { tools: readOnly ? tools.filter(isReadOnly) : tools };
	});
	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		const { name, arguments: args = {}, _meta } = request.params;
		const progressToken = _meta?.progressToken;
		if (_meta?.[YIELDS_META] !== true || progressToken === undefined)
			return callTool(name, args, { readOnly });
		let progress = 0;
		return callTool(name, args, {
			readOnly,
			signal: extra.signal,
			onYield: (value) =>
				extra.sendNotification({
					method: 'notifications/progress',
					params: {
						progressToken,
						progress: ++progress,
						_meta: { [YIELD_META]: value },
					},
				}),
		});
	});
	return server;
}

/** Serve every healthy app in the Epicenter until the client ends stdin. */
export async function serveStdio(): Promise<number> {
	const server = await createMcpServer();
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

/**
 * `epicenter serve --stdio`: your apps' actions over MCP (ADR-0849, ADR-0853).
 *
 * The server never imports an app. `tools/list` runs `epicenter <app> --json`
 * for each home entry and offers the actions each lists; `tools/call` decodes
 * the tool name and runs `epicenter <app> <words> --input <json>` in a fresh
 * process, which checks the app, the action, and the input. So the
 * code and declaration on disk when a call arrives are what runs, an edit
 * between two calls is seen by the second, and a call's result is the same
 * object `--json` prints: `structuredContent` on success, and with
 * `isError` on failure. Stdout belongs to the protocol; diagnostics go to
 * stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../package.json' with { type: 'json' };
import { renderReport, writeErr } from './output.ts';
import { runChild } from './child.ts';
import { entryNames } from './home.ts';
import type { RunReport, Unknown } from './report.ts';

/**
 * The tools the home offers now. Each entry is listed by its own child, so an
 * app that fails to import, or prints while importing, loses only its own
 * tools; why is written to stderr.
 */
async function listTools(): Promise<Tool[]> {
	const listed = await Promise.all(
		(await entryNames()).map(async (entry) => {
			const { answer } = await runChild([entry, '--json'], { stdin: 'ignore' });
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
 * `structuredContent`, and `isError` exactly when the exit code is not 0.
 * A failure's text is what a person would read on stderr.
 */
function toolResult(answer: unknown, code: number) {
	const value = answer as Record<string, unknown>;
	if (code === 0)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(value) }],
			structuredContent: value,
		};
	const text =
		'error' in value
			? (value.error as { message: string }).message
			: 'unknown' in value
				? (value as Unknown).unknown.message
				: renderReport(value as RunReport).stderr.trim();
	return {
		isError: true,
		content: [{ type: 'text' as const, text }],
		structuredContent: value,
	};
}

/** Serve every healthy app in the home until the client ends stdin. */
export async function serveStdio(): Promise<number> {
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: await listTools(),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		// `<app>_<word>_<word>`: no app name or action word holds an underscore, so this undoes the encoding.
		const [app = '', ...words] = request.params.name.split('_');
		const { answer, code } = await runChild(
			[
				app,
				...words,
				'--input',
				JSON.stringify(request.params.arguments ?? {}),
				'--json',
			],
			{ stdin: 'ignore' },
		);
		return toolResult(answer, code);
	});
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

/**
 * `epicenter serve --stdio`: your apps' actions over MCP (ADR-0849, ADR-0853).
 *
 * The server never imports an app. `tools/list` runs `epicenter --json` and
 * offers each action it lists; `tools/call` runs
 * `epicenter <app> <words> --input <json> --json` in a fresh process. So the
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
import type { RunReport, Unknown } from './report.ts';

type Listed = {
	apps: { name: string; actions: Tool[] }[];
	problems: { entry: string; problems: string[] }[];
};

/** The tools the home offers now, each with the app and action words that run it. */
async function listTools() {
	const { apps, problems } = (await runChild(['--json'], { stdin: 'ignore' }))
		.answer as Listed;
	for (const { entry, problems: found } of problems)
		writeErr(`${entry}: ${found.join('; ')}`);
	return apps.flatMap((app) =>
		app.actions.map((tool) => ({
			tool,
			app: app.name,
			words: tool.name.slice(app.name.length + 1).split('_'),
		})),
	);
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
		tools: (await listTools()).map(({ tool }) => tool),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const found = (await listTools()).find(
			({ tool }) => tool.name === request.params.name,
		);
		if (!found) {
			const error = {
				name: 'Usage',
				message: `Unknown tool ${request.params.name}`,
			};
			return {
				isError: true,
				content: [{ type: 'text' as const, text: error.message }],
				structuredContent: { error },
			};
		}
		const { answer, code } = await runChild(
			[
				found.app,
				...found.words,
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

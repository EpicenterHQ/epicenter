/**
 * `epicenter serve --stdio`: your apps' actions over MCP (ADR-0849, ADR-0853),
 * and `sync` (ADR-0851).
 *
 * The server never imports an app. `tools/list` runs `epicenter <app> --json`
 * for each home entry and offers the actions each lists; `tools/call` decodes
 * the tool name and runs `epicenter <app> <words> --input <json>` in a fresh
 * process, which checks the app, the action, and the input. So the
 * code and declaration on disk when a call arrives are what runs, an edit
 * between two calls is seen by the second, and a call's result is the same
 * object `--json` prints: `structuredContent` on success, and with
 * `isError` on failure. The tool `sync` runs `epicenter sync [<app>]` the
 * same way; no app's tool can be named `sync`, since every app tool holds an
 * underscore. Stdout belongs to the protocol; diagnostics go to stderr.
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
import { renderAnswer, writeErr } from './output.ts';
import { type Answer, exitCodeOf } from './report.ts';
import { renderSync, type SyncAnswer, syncExitCode } from './sync.ts';

/** The tool for `epicenter sync`, offered beside every app's actions. */
const SYNC_TOOL: Tool = {
	name: 'sync',
	description:
		'Commit what is left in each app, or the one named, then pull with --rebase and push to its upstream',
	inputSchema: {
		type: 'object',
		properties: {
			app: { type: 'string', description: 'One app; every app when absent' },
		},
		additionalProperties: false,
	},
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
};

/**
 * The tools the home offers now. Each entry is listed by its own child, so an
 * app that fails to import, or prints while importing, loses only its own
 * tools; why is written to stderr.
 */
async function listTools(): Promise<Tool[]> {
	const listed = await Promise.all(
		(await homeEntries()).map(async ({ entry }) => {
			const answer = await runChild([entry, '--json'], { stdin: 'ignore' });
			const value = answer as { actions?: Tool[]; error?: { message: string } };
			if (value.actions) return value.actions;
			writeErr(`${entry}: ${value.error?.message ?? JSON.stringify(answer)}`);
			return [];
		}),
	);
	return [SYNC_TOOL, ...listed.flat()];
}

/**
 * A child's answer as an MCP result: the same value `--json` prints, as
 * `structuredContent`, and `isError` exactly when the exit code is not 0.
 * A failure's text is what a person would read on stderr.
 */
function toolResult(answer: Answer) {
	const structuredContent = answer as Record<string, unknown>;
	if (exitCodeOf(answer) === 0)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
			structuredContent,
		};
	const text = renderAnswer(answer).stderr.trim();
	return {
		isError: true,
		content: [{ type: 'text' as const, text }],
		structuredContent,
	};
}

/** A sync's answer as an MCP result, with `isError` when any app did not sync or nothing ran. */
function syncResult(answer: SyncAnswer | Answer) {
	if ('error' in answer) return toolResult(answer);
	const structuredContent = answer as Record<string, unknown>;
	if ('apps' in answer && syncExitCode(answer) === 0)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
			structuredContent,
		};
	const text =
		'apps' in answer
			? renderSync(answer).stderr.trim()
			: renderAnswer(answer).stderr.trim();
	return {
		isError: true,
		content: [{ type: 'text' as const, text }],
		structuredContent,
	};
}

/**
 * `sync`'s arguments as words, or why they are not `{ app?: string }`. An app
 * must be a name, so it can never be read as a flag.
 */
function syncWords(args: Record<string, unknown>): string[] | Answer {
	const { app, ...rest } = args;
	if (Object.keys(rest).length || (app !== undefined && !isName(app)))
		return {
			error: {
				name: 'Usage',
				message: 'sync takes { app?: <an app name> } and nothing else',
			},
		};
	return app === undefined ? [] : [app];
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
		if (request.params.name === 'sync') {
			const words = syncWords(request.params.arguments ?? {});
			if (!Array.isArray(words)) return toolResult(words);
			return syncResult(
				(await runChild(['sync', ...words, '--json'], {
					stdin: 'ignore',
				})) as SyncAnswer | Answer,
			);
		}
		// `<app>_<word>_<word>`: no app name or action word holds an underscore, so this undoes the encoding.
		const [app = '', ...words] = request.params.name.split('_');
		const answer = await runChild(
			[
				app,
				...words,
				'--input',
				JSON.stringify(request.params.arguments ?? {}),
				'--json',
			],
			{ stdin: 'ignore' },
		);
		return toolResult(answer as Answer);
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

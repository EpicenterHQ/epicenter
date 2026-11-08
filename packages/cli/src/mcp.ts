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
import { writeErr } from './output.ts';

/** How to run this same `epicenter`: the compiled binary alone, or Bun with this entry. */
function self(): string[] {
	return Bun.main.startsWith('/$bunfs/')
		? [process.execPath]
		: [process.execPath, Bun.main];
}

async function epicenter(args: string[]) {
	const child = Bun.spawn([...self(), ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr: stderr.trim(), code };
}

type Listed = {
	apps: { name: string; actions: Tool[] }[];
	problems: { entry: string; problems: string[] }[];
};

/** The tools the home offers now, each with the app and action words that run it. */
async function listTools() {
	const listed = await epicenter(['--json']);
	const { apps, problems } = JSON.parse(listed.stdout) as Listed;
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

function textOf(value: unknown) {
	return [{ type: 'text' as const, text: JSON.stringify(value) }];
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
		const called = await epicenter([
			found.app,
			...found.words,
			'--input',
			JSON.stringify(request.params.arguments ?? {}),
			'--json',
		]);
		if (called.stderr) writeErr(called.stderr);
		let answer: Record<string, unknown>;
		try {
			answer = JSON.parse(called.stdout);
		} catch {
			const error = {
				name: 'ActionThrew',
				message: called.stderr || `epicenter exited ${called.code}`,
			};
			return {
				isError: true,
				content: [{ type: 'text' as const, text: error.message }],
				structuredContent: { error },
			};
		}
		if (called.code === 0)
			return { content: textOf(answer), structuredContent: answer };
		const message = (answer.error as { message?: string } | undefined)?.message;
		return {
			isError: true,
			content: [
				{ type: 'text' as const, text: message ?? JSON.stringify(answer) },
			],
			structuredContent: answer,
		};
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

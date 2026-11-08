/**
 * The local MCP server for app actions (ADR-0841). Each action becomes a tool
 * with its input schema and hints; execution shares the command line's runner.
 * Stdout belongs to the protocol, and diagnostics go to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../package.json' with { type: 'json' };
import { discoverAll, type Located, loadHomeApp, Refusal } from './home.ts';
import { checkInput, inputSchema } from './input.ts';
import { fail, writeErr } from './output.ts';
import { runAction } from './run.ts';

/** Build one MCP tool per healthy app action, sharing input checks and execution with the CLI. */
export function createMcpServer(apps: Located[]): Server {
	const tools = apps.flatMap((located) => {
		if (located.problems.length || !located.app) return [];
		return Object.entries(located.app.actions).map(([key, action]) => ({
			located,
			key,
			action,
			tool: {
				name: `${located.name}_${key.replaceAll(' ', '_')}`,
				description: action.description,
				inputSchema: inputSchema(action),
				annotations: {
					readOnlyHint: action.readOnly === true,
					destructiveHint: action.destructive === true,
				},
			},
		}));
	});
	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(({ tool }) => tool),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const found = tools.find(({ tool }) => tool.name === request.params.name);
		const error = (text: string) => ({
			isError: true,
			content: [{ type: 'text' as const, text }],
		});
		if (!found) return error(`Unknown tool ${request.params.name}`);
		const checked = checkInput(
			found.action,
			request.params.arguments ?? {},
			(key) => key,
		);
		if ('error' in checked) return error(checked.error);
		const result = await runAction(found.located, found.key, checked.input);
		if (!result.ok) return error(result.error);
		const value = result.value;
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }],
			...(value !== null &&
			typeof value === 'object' &&
			Object.getPrototypeOf(value) === Object.prototype
				? { structuredContent: value as Record<string, unknown> }
				: {}),
		};
	});
	return server;
}

/** Serve the selected home apps until the MCP transport closes, keeping stdout for protocol only. */
export async function mcpCommand(names: string[]): Promise<number> {
	let apps: Located[];
	try {
		if (names.length) {
			apps = await Promise.all([...new Set(names)].map(loadHomeApp));
			const broken = apps.filter((app) => app.problems.length);
			if (broken.length)
				return fail(
					{
						code: 'usage',
						message: broken
							.map((app) => `${app.entry}: ${app.problems.join('; ')}`)
							.join('\n'),
					},
					false,
				);
		} else {
			const found = await discoverAll();
			apps = found.apps;
			for (const app of found.problems)
				writeErr(`${app.entry}: ${app.problems.join('; ')}`);
		}
	} catch (error) {
		return fail(
			{
				code: 'usage',
				message: error instanceof Error ? error.message : String(error),
				next: error instanceof Refusal ? error.next : undefined,
			},
			false,
		);
	}
	const server = createMcpServer(apps);
	const transport = new StdioServerTransport();
	const { promise: closed, resolve: closeNow } = Promise.withResolvers<void>();
	server.onclose = closeNow;
	// The SDK's stdio transport does not close itself when stdin ends.
	process.stdin.once('end', closeNow);
	try {
		await server.connect(transport);
		writeErr(`Serving ${apps.length} apps over MCP.`);
		await closed;
		return 0;
	} finally {
		process.stdin.off('end', closeNow);
		await server.close();
	}
}

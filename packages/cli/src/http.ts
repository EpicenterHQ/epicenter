/** HTTP MCP and static app views for `epicenter serve` (ADR-0864). */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { commitFolder, git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import {
	callTool,
	createMcpServer,
	listTools,
	runAppTool,
	toolResult,
} from './mcp.ts';
import { writeErr } from './output.ts';

type ToolResult = Awaited<ReturnType<typeof callTool>>;
type AppWrite = {
	tail: Promise<void>;
	pushing?: Promise<void>;
	pushAgain: boolean;
};

function commitSubject(app: string, words: string[], value: unknown) {
	const suffix =
		value === undefined
			? ''
			: ` ${typeof value === 'string' ? value : JSON.stringify(value)}`;
	return `${app}: ${words.join(' ')}${suffix.replace(/\s+/g, ' ').slice(0, 61)}`;
}

/** Start the server. The caller owns its lifetime. Port 0 asks Bun for a free port. */
export function startHttpServer(host: string, port: number) {
	let tools: Map<string, Tool> | undefined;
	const writes = new Map<string, AppWrite>();
	const refresh = async () => {
		const listed = await listTools();
		tools = new Map(listed.map((tool) => [tool.name, tool]));
		return listed;
	};
	const state = (app: string) => {
		let current = writes.get(app);
		if (!current) {
			current = { tail: Promise.resolve(), pushAgain: false };
			writes.set(app, current);
		}
		return current;
	};
	const push = (app: string, folder: string, current: AppWrite) => {
		if (current.pushing) {
			current.pushAgain = true;
			return;
		}
		current.pushing = (async () => {
			do {
				current.pushAgain = false;
				const upstream = await git(folder, [
					'rev-parse',
					'--abbrev-ref',
					'--symbolic-full-name',
					'@{upstream}',
				]);
				if (upstream.code !== 0) return;
				const args = ['push', '-q'];
				const result = await git(folder, args);
				if (result.code !== 0)
					writeErr(`${app}: push failed: ${gitMessage(args, result)}`);
			} while (current.pushAgain);
		})()
			.catch((error) => {
				writeErr(
					`${app}: push failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				current.pushing = undefined;
				if (current.pushAgain) push(app, folder, current);
			});
	};
	const call = async (
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolResult> => {
		if (name === 'sync') return callTool(name, args);
		let tool = tools?.get(name);
		if (!tool) tool = (await refresh()).find((item) => item.name === name);
		if (!tool || tool.annotations?.readOnlyHint === true)
			return callTool(name, args);
		const [app = '', ...words] = name.split('_');
		const entry = (await homeEntries()).find((item) => item.entry === app);
		if (!entry) return callTool(name, args);
		const current = state(app);
		const run = async () => {
			const called = await runAppTool(name, args);
			const result = toolResult(called.answer);
			if (result.isError) return result;
			if (!called.folder) return result;
			const repository = await git(called.folder, [
				'rev-parse',
				'--is-inside-work-tree',
			]);
			if (repository.code !== 0 || repository.stdout !== 'true') return result;
			try {
				await commitFolder(
					called.folder,
					commitSubject(app, words, called.firstPositional),
				);
				push(app, called.folder, current);
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeErr(`${app}: commit failed: ${message}`);
				return {
					...result,
					structuredContent: {
						...result.structuredContent,
						uncommitted: { message, next: `epicenter sync ${app}` },
					},
					content: [
						...result.content,
						{
							type: 'text' as const,
							text: `The action returned, but its changes were not committed: ${message}`,
						},
					],
				};
			}
		};
		const result = current.tail.then(run, run);
		current.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const notFound = () => new Response('Not found', { status: 404 });
	const viewFile = async (app: string, path: string) => {
		if (!isName(app)) return notFound();
		const entry = (await homeEntries()).find((item) => item.entry === app);
		if (!entry) return notFound();
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return notFound();
		}
		if (
			decoded.includes('\\') ||
			isAbsolute(decoded) ||
			decoded.split('/').some((part) => part === '.' || part === '..')
		)
			return notFound();
		try {
			const root = await realpath(join(entry.realPath, 'views'));
			if (!root.startsWith(`${entry.realPath}${sep}`)) return notFound();
			const candidate = join(root, decoded || 'index.html');
			const file = await realpath(
				(await stat(candidate)).isDirectory()
					? join(candidate, 'index.html')
					: candidate,
			);
			if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile())
				return notFound();
			return new Response(Bun.file(file), {
				headers: {
					'cache-control': decoded.startsWith('_app/immutable/')
						? 'public, max-age=31536000, immutable'
						: 'no-cache',
				},
			});
		} catch {
			return notFound();
		}
	};
	return Bun.serve({
		hostname: host,
		port,
		idleTimeout: 0,
		async fetch(request) {
			const origin = request.headers.get('origin');
			if (origin !== null) {
				let originHost: string;
				try {
					originHost = new URL(origin).host;
				} catch {
					return new Response('Forbidden', { status: 403 });
				}
				if (
					originHost.toLowerCase() !==
					request.headers.get('host')?.toLowerCase()
				)
					return new Response('Forbidden', { status: 403 });
			}
			const { pathname } = new URL(request.url);
			if (pathname === '/mcp') {
				if (request.method !== 'POST')
					return new Response('Method not allowed', { status: 405 });
				const server = createMcpServer(refresh, call);
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
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return notFound();
			if (pathname === '/') {
				const apps = await Promise.all(
					(await homeEntries()).map(async (entry) => {
						const response = await viewFile(entry.entry, 'index.html');
						return response.ok ? entry.entry : undefined;
					}),
				);
				const links = apps
					.filter((app) => app !== undefined)
					.map(
						(app) =>
							`<li><a href="/${encodeURIComponent(app)}/">${app}</a></li>`,
					)
					.join('');
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><title>Epicenter</title></head><body><h1>Apps</h1><ul>${links}</ul></body></html>`,
					{
						headers: {
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'no-cache',
						},
					},
				);
			}
			const match = /^\/([^/]+)(?:\/(.*))?$/.exec(pathname);
			if (!match) return notFound();
			const app = match[1];
			if (!isName(app)) return notFound();
			if (match[2] === undefined) {
				if (!(await homeEntries()).some((entry) => entry.entry === app))
					return notFound();
				// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
				return new Response(null, {
					status: 308,
					headers: { location: `/${encodeURIComponent(app)}/` },
				});
			}
			return viewFile(app, match[2]);
		},
	});
}

/** Keep the command alive until its process receives a signal. */
export async function serveHttp(host: string, port: number): Promise<number> {
	const server = startHttpServer(host, port);
	writeErr(`Serving your apps at http://${host}:${server.port}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return 0;
}

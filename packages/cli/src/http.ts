/**
 * `epicenter serve` over HTTP (ADR-0864): one address for people and agents.
 *
 * ```txt
 * POST /             MCP, stateless JSON
 * GET  /             the launcher; 405 when asked for an event stream (MCP)
 * GET  /<app>/...    the app's built UI, .cache/ui/, as static files
 * GET  /<app>        308 to /<app>/
 * ```
 *
 * Any later path of the server's own starts with `.`, which no app name can,
 * so no name is reserved for the server.
 *
 * A write call is snapshotted before it answers (`mcp.ts`). Every minute the
 * server also looks at each app's pending changes: an app whose
 * `git status --porcelain` is not empty and is the same as a minute ago has
 * edits from outside that have gone quiet, and gets a snapshot. Each snapshot
 * that commits is pushed to `origin` in the background.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { runChild } from './child.ts';
import { git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import { callTool, createMcpServer, listTools } from './mcp.ts';
import { writeErr } from './output.ts';
import { epicenterDir, rootInstructions } from './root.ts';
import { pendingStatus, snapshot } from './snapshot.ts';
import { BUILT_UI } from './ui.ts';

/** An app's background push: the one running, and whether another is wanted after it. */
type Push = { running?: Promise<void>; again: boolean };

/** How often `serve` looks for outside edits that have gone quiet. */
const QUIET_CHECK_MS = 60_000;

const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				char
			] as string,
	);

/** The page at `/`: each app with a UI, its icon, name, and description, linking to `/<app>/`. */
function launcherPage(
	name: string,
	apps: { name: string; description: string; icon: boolean }[],
) {
	const items = apps
		.map(({ name, description, icon }) => {
			const href = `/${encodeURIComponent(name)}/`;
			const image = icon
				? `<img src="${href}icon.png" alt="" width="56" height="56">`
				: `<span class="blank">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
			return `<li><a href="${href}">${image}<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></span></a></li>`;
		})
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${escapeHtml(name)}</title><style>
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#6b6b6b;--card:#fff;--line:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f5;--muted:#a0a0a0;--card:#1e1e1e;--line:#2c2c2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{max-width:560px;margin:0 auto}h1{font-size:28px;margin:8px 0 20px;letter-spacing:-.02em}
ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
a{display:flex;gap:14px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:16px;background:var(--card);color:inherit;text-decoration:none}
a:active{transform:scale(.99)}img,.blank{width:56px;height:56px;border-radius:13px;flex:none}
.blank{display:grid;place-items:center;background:var(--line);font-weight:600;font-size:22px}
strong{display:block;font-size:17px;text-transform:capitalize}small{display:block;color:var(--muted);font-size:14px}
p{color:var(--muted)}
</style></head><body><main><h1>${escapeHtml(name)}</h1>${items ? `<ul>${items}</ul>` : '<p>No app here has a UI yet.</p>'}</main></body></html>`;
}

/**
 * Start the server. The caller owns its lifetime. Port 0 asks Bun for a free
 * port. `quietCheckMs` is how often it looks for quiet outside edits.
 */
export function startHttpServer(
	host: string,
	port: number,
	instructions?: string,
	quietCheckMs = QUIET_CHECK_MS,
) {
	const pushes = new Map<string, Push>();
	/**
	 * Push the app's branch to `origin` by name in the background, if it has
	 * one: never to `upstream`, the starter it came from (ADR-0866). A push
	 * asked for while one runs makes one more after it, so every commit goes
	 * out and pushes never overlap.
	 */
	const push = (app: string, folder: string) => {
		let current = pushes.get(app);
		if (!current) {
			current = { again: false };
			pushes.set(app, current);
		}
		if (current.running) {
			current.again = true;
			return;
		}
		const state = current;
		state.running = (async () => {
			do {
				state.again = false;
				if ((await git(folder, ['remote', 'get-url', 'origin'])).code !== 0)
					return;
				const branch = (
					await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'])
				).stdout;
				if (branch === '') return;
				const args = ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`];
				const result = await git(folder, args);
				if (result.code !== 0)
					writeErr(`${app}: push failed: ${gitMessage(args, result)}`);
			} while (state.again);
		})()
			.catch((error) => {
				writeErr(
					`${app}: push failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				state.running = undefined;
			});
	};
	/** Run the tool; when its snapshot commits, push that app. */
	const call: typeof callTool = (name, args) => callTool(name, args, push);
	/** Each app's `git status --porcelain` at the last check, by folder. */
	const lastStatus = new Map<string, string>();
	/** Snapshot and push each app whose pending changes are what they were at the last check. */
	const checkQuiet = async () => {
		for (const { entry, realPath } of await homeEntries()) {
			const status = (await pendingStatus(realPath)) ?? '';
			const before = lastStatus.get(realPath);
			lastStatus.set(realPath, status);
			if (status === '' || status !== before) continue;
			const taken = await snapshot(entry, realPath);
			if ('failed' in taken)
				writeErr(`${entry}: not yet in history: ${taken.failed}`);
			else if (taken.committed) push(entry, realPath);
		}
	};
	const scheduleCheck = () => {
		setTimeout(() => {
			void checkQuiet()
				.catch((error) => {
					writeErr(
						`Looking for quiet changes failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(scheduleCheck);
		}, quietCheckMs).unref();
	};
	scheduleCheck();
	const notFound = () => new Response('Not found', { status: 404 });
	const uiFile = async (app: string, path: string) => {
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
			// The built UI, rebuildable and ignored, is the only thing served (ADR-0866).
			const root = await realpath(join(entry.realPath, BUILT_UI));
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
			if (pathname === '/') {
				if (request.method === 'POST') {
					const server = createMcpServer(instructions, listTools, call);
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
				// MCP's GET for a server-sent stream: stateless, so there is none.
				const wantsStream = request.headers
					.get('accept')
					?.includes('text/event-stream');
				if (
					(request.method !== 'GET' && request.method !== 'HEAD') ||
					wantsStream
				)
					return new Response('Method not allowed', {
						status: 405,
						headers: { allow: 'GET, HEAD, POST' },
					});
				const apps = await Promise.all(
					(await homeEntries()).map(async (entry) => {
						if (!(await uiFile(entry.entry, 'index.html')).ok) return undefined;
						// Read in a child, as tools/list is: serve never imports an app.
						const listed = (
							await runChild([entry.entry, '--json'], { stdin: 'ignore' })
						).answer as { description?: unknown };
						return {
							name: entry.entry,
							description:
								typeof listed.description === 'string'
									? listed.description
									: '',
							icon: (await uiFile(entry.entry, 'icon.png')).ok,
						};
					}),
				);
				return new Response(
					launcherPage(
						basename(epicenterDir()),
						apps.filter((app) => app !== undefined),
					),
					{
						headers: {
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'no-cache',
						},
					},
				);
			}
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return notFound();
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
			return uiFile(app, match[2]);
		},
	});
}

/** Keep the command alive until its process receives a signal. */
export async function serveHttp(host: string, port: number): Promise<number> {
	// A test looks for quiet changes sooner than every minute.
	const every = Number(process.env.EPICENTER_QUIET_CHECK_MS) || undefined;
	const server = startHttpServer(host, port, await rootInstructions(), every);
	writeErr(`Serving your apps at http://${host}:${server.port}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	server.stop();
	return 0;
}

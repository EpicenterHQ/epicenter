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
 * A write call commits the paths it wrote before it answers (`mcp.ts`).
 * Everything else reaches history and the backup on the server's clock: when
 * it starts, every 5 minutes, and when it stops, it does for each app what
 * `epicenter sync <app>` does, snapshotting what is pending as changed
 * outside epicenter and pushing to `origin` when there is something to push.
 * The clock's interval is how old an unbacked change can get, not a guess at
 * when an edit is done.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { isName } from '@epicenter/app';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { extractErrorMessage } from 'wellcrafted/error';
import { runChild } from './child.ts';
import { chooseApps, homeEntries } from './home.ts';
import { createMcpServer } from './mcp.ts';
import { writeErr } from './output.ts';
import { epicenterDir, rootInstructions } from './root.ts';
import { type Synced, syncOne } from './sync.ts';
import { BUILT_UI } from './ui.ts';

/** How often `serve` backs up every app. */
const BACKUP_EVERY_MS = 5 * 60_000;

/** How long `serve` waits for the backup it runs when it stops. */
const BACKUP_WAIT_MS = 10_000;

/** Whether `work` finished within `ms`; it runs on after `false`. */
function within(ms: number, work: Promise<unknown>) {
	const { promise: late, resolve } = Promise.withResolvers<false>();
	setTimeout(() => resolve(false), ms).unref();
	return Promise.race([work.then(() => true as const), late]);
}

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
 * Start the server and its backup clock, which backs up once now and every 5
 * minutes after. The caller owns its lifetime and ends it with `stop`. Port 0
 * asks Bun for a free port. `tick` runs one backup now, after any already
 * running, and answers what it did per app.
 */
export function startHttpServer(
	host: string,
	port: number,
	instructions?: string,
) {
	/** Each app's last backup failure as logged, so an unchanged one is logged once. */
	const lastFailure = new Map<string, string>();
	const backUpAll = async () => {
		const backedUp: Synced[] = [];
		for (const { entry, realPath } of await homeEntries()) {
			const synced = await syncOne(entry, realPath);
			backedUp.push(synced);
			const failure =
				synced.error &&
				`${synced.error.message}${synced.error.next ? `\nRun: ${synced.error.next}` : ''}`;
			if (!failure) lastFailure.delete(realPath);
			else if (lastFailure.get(realPath) !== failure) {
				writeErr(failure);
				lastFailure.set(realPath, failure);
			}
		}
		return backedUp;
	};
	let previous: Promise<unknown> = Promise.resolve();
	const tick = (): Promise<Synced[]> => {
		const next = previous.then(backUpAll);
		previous = next.catch(() => undefined);
		return next;
	};
	const tickLogged = () =>
		tick().catch((error) => {
			writeErr(`Backing up failed: ${extractErrorMessage(error)}`);
		});
	let clock: ReturnType<typeof setTimeout> | undefined;
	let stopping = false;
	const schedule = () => {
		if (stopping) return;
		clock = setTimeout(() => {
			void tickLogged().finally(schedule);
		}, BACKUP_EVERY_MS);
		clock.unref();
	};
	void tickLogged().finally(schedule);
	const notFound = () => new Response('Not found', { status: 404 });
	const uiFile = async (app: string, path: string) => {
		if (!isName(app)) return notFound();
		const [entry] = (await chooseApps(app)).data ?? [];
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
	const server = Bun.serve({
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
					const server = createMcpServer(instructions);
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
							await runChild([entry.entry, '--json'], 'ignore')
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
				if ((await chooseApps(app)).error) return notFound();
				// Relative, so a proxy in front (tailscale serve) keeps its own host and scheme.
				return new Response(null, {
					status: 308,
					headers: { location: `/${encodeURIComponent(app)}/` },
				});
			}
			return uiFile(app, match[2]);
		},
	});
	return {
		port: server.port as number,
		tick,
		/**
		 * Stop listening and the clock, then run the last backup, waiting for
		 * it at most 10 seconds; `false` when it gave up waiting.
		 */
		stop() {
			stopping = true;
			clearTimeout(clock);
			void server.stop();
			return within(BACKUP_WAIT_MS, tickLogged());
		},
	};
}

/** Serve until the process receives SIGINT or SIGTERM, then back up once more. */
export async function serveHttp(host: string, port: number): Promise<number> {
	const server = startHttpServer(host, port, await rootInstructions());
	writeErr(`Serving your apps at http://${host}:${server.port}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	if (!(await server.stop())) {
		// A push still waiting on the network would keep the process alive.
		writeErr('Stopped without waiting longer for the last backup.');
		process.exit(0);
	}
	return 0;
}

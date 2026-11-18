// Hosted Tasks experiment. OAuth authorization lives in the API gateway.
import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { compilerCode } from '../compiler-artifact/loader.js';
import { homeCss, homePage } from '../home/page.js';
import homeScript from '../shell-artifact/main.txt';
import { homeKey } from './access.js';
import type { Source } from './build.js';
import type { Compiler } from './compiler.js';
import type { HostedActions } from './hosted-actions.js';
import { RunHost } from './run-host.js';
import { serverSource } from './server-source.js';

type Env = {
	OWNER: DurableObjectNamespace<TasksOwner>;
	LOADER: WorkerLoader;
	ADMIN_TOKEN: string;
	API_ORIGIN: string;
	TEST_INTERRUPTION?: string;
};
const encoder = new TextEncoder();
function json(value: unknown, status = 200) {
	return Response.json(value, { status });
}
const mime = (path: string) =>
	path.endsWith('.html')
		? 'text/html; charset=utf-8'
		: path.endsWith('.js')
			? 'text/javascript; charset=utf-8'
			: path.endsWith('.css')
				? 'text/css; charset=utf-8'
				: path.endsWith('.svg')
					? 'image/svg+xml'
					: path.endsWith('.woff2')
						? 'font/woff2'
						: path.endsWith('.png')
							? 'image/png'
							: 'application/octet-stream';

const STARTER = 'hosted-starter-v1';
export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		if (url.pathname === '/health')
			return json({
				prototype: 'tasks-workers',
				runtime: 'workerd',
				containers: false,
				auth: 'epicenter-oauth',
			});
		// The deployment credential can update the starter, never a person's home.
		if (url.pathname.startsWith('/platform/template/')) {
			if (
				!env.ADMIN_TOKEN ||
				request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`
			)
				return json({ error: 'Unauthorized' }, 401);
			url.pathname = url.pathname.slice('/platform/template'.length);
			return env.OWNER.getByName(STARTER).fetch(new Request(url, request));
		}
		const headers = {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy': `default-src 'none'; script-src 'self' data: 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src ${new URL(env.API_ORIGIN).origin}; frame-src 'self' about: data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
		};
		if (url.pathname === '/home.js')
			return new Response(
				homeScript.replaceAll(
					'__HOME_API_ORIGIN__',
					JSON.stringify(new URL(env.API_ORIGIN).origin),
				),
				{
					headers: {
						...headers,
						'Content-Type': 'text/javascript; charset=utf-8',
					},
				},
			);
		if (url.pathname === '/home.css')
			return new Response(homeCss, {
				headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' },
			});
		if (url.pathname === '/' || url.pathname === '/auth/callback')
			return new Response(homePage, {
				headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
			});
		return json(
			{ error: 'Use the Epicenter API with a hosted-home OAuth token.' },
			401,
		);
	},
} satisfies ExportedHandler<Env>;

// Only the account's API Worker has a service binding to this named entrypoint.
// HTTP callers cannot select it or supply the verified principal argument.
export class HomeGateway extends WorkerEntrypoint<Env> {
	async owner(authority: string, principal: string, request: Request) {
		if (!principal || !authority)
			return json({ error: 'Missing authenticated identity' }, 403);
		const home = this.env.OWNER.getByName(
			'home:' + (await homeKey(authority, principal)),
		);
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/homes/'))
			return json({ error: 'Invalid resource path' }, 404);
		url.pathname = url.pathname.slice('/homes'.length);
		if (url.pathname === '/provision' && request.method === 'POST') {
			await request.text();
			await home.ensureStarter();
			return json({ ready: true });
		}
		// Never persist or pass an account credential into the home or app runtime.
		const forwarded = new Request(url, request);
		forwarded.headers.delete('Authorization');
		forwarded.headers.delete('Cookie');
		forwarded.headers.delete('x-epicenter-principal');
		return home.hosted(forwarded);
	}
}

export class TasksOwner extends DurableObject<Env> {
	private building = false;
	private runs: RunHost;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS source(path TEXT PRIMARY KEY,text TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,text TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS file_versions(path TEXT PRIMARY KEY,version INTEGER NOT NULL); INSERT OR IGNORE INTO file_versions SELECT path,version FROM files; CREATE TABLE IF NOT EXISTS assets(revision TEXT,path TEXT,body BLOB,PRIMARY KEY(revision,path)); CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY,bundle TEXT,detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
		);
		this.runs = new RunHost(ctx, env.LOADER, this, () => this.published());
	}
	private initializing?: Promise<void>;
	async hosted(request: Request) {
		if (!this.active())
			return json({ error: 'Provision your home first.' }, 404);
		return this.fetch(request);
	}
	async ensureStarter() {
		if (this.active()) return;
		if (!this.initializing)
			this.initializing = (async () => {
				const starter = this.env.OWNER.getByName(STARTER);
				const header = await starter.starterHeader();
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						'DELETE FROM source; DELETE FROM assets; DELETE FROM builds;',
					);
				});
				// Bounded pages avoid a single near-limit RPC containing the toolchain.
				for (const kind of ['source', 'assets'] as const) {
					let cursor = 0;
					while (true) {
						const page = await starter.starterPage(header.stamp, kind, cursor);
						if (!page.cursor) break;
						this.ctx.storage.transactionSync(() => {
							for (const row of page.source)
								this.ctx.storage.sql.exec(
									'INSERT OR REPLACE INTO source VALUES(?,?)',
									row.path,
									row.text,
								);
							for (const row of page.assets)
								this.ctx.storage.sql.exec(
									'INSERT OR REPLACE INTO assets VALUES(?,?,?)',
									row.revision,
									row.path,
									row.body,
								);
						});
						cursor = page.cursor;
					}
				}
				// Also detect a starter edit after the final page, before activation.
				if ((await starter.starterHeader()).stamp !== header.stamp)
					throw new Error('Starter changed during provisioning. Try again.');
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						'INSERT INTO builds VALUES(?,?,?)',
						header.build.id,
						header.build.bundle,
						header.build.detail,
					);
					this.ctx.storage.sql.exec(
						"INSERT INTO meta VALUES('active',?)",
						header.build.id,
					);
				});
			})().finally(() => {
				this.initializing = undefined;
			});
		await this.initializing;
	}
	private starterStamp() {
		const version =
			this.ctx.storage.sql
				.exec<{ value: string }>(
					"SELECT value FROM meta WHERE key='source-version'",
				)
				.toArray()[0]?.value ?? '0';
		return this.active() + ':' + version;
	}
	starterHeader() {
		const id = this.active();
		if (!id) throw new Error('Starter has no successful build');
		return {
			stamp: this.starterStamp(),
			build: this.ctx.storage.sql
				.exec<{ id: string; bundle: string; detail: string }>(
					'SELECT * FROM builds WHERE id=?',
					id,
				)
				.toArray()[0],
		};
	}
	starterPage(stamp: string, kind: 'source' | 'assets', cursor: number) {
		if (stamp !== this.starterStamp())
			throw new Error('Starter changed during provisioning. Try again.');
		const page: {
			cursor: number;
			source: { path: string; text: string }[];
			assets: { revision: string; path: string; body: ArrayBuffer }[];
		} = { cursor: 0, source: [], assets: [] };
		let bytes = 0;
		if (kind === 'source') {
			for (const row of this.ctx.storage.sql.exec<{
				cursor: number;
				path: string;
				text: string;
			}>(
				'SELECT rowid AS cursor,path,text FROM source WHERE rowid>? ORDER BY rowid LIMIT 128',
				cursor,
			)) {
				const size = Buffer.byteLength(row.text) + Buffer.byteLength(row.path);
				if (bytes && bytes + size > 4 * 1024 * 1024) break;
				page.source.push({ path: row.path, text: row.text });
				page.cursor = row.cursor;
				bytes += size;
			}
		} else {
			for (const row of this.ctx.storage.sql.exec<{
				cursor: number;
				revision: string;
				path: string;
				body: ArrayBuffer;
			}>(
				'SELECT rowid AS cursor,revision,path,body FROM assets WHERE rowid>? AND revision IN (?,?) ORDER BY rowid LIMIT 128',
				cursor,
				this.active(),
				'static',
			)) {
				const size = row.body.byteLength + Buffer.byteLength(row.path);
				if (bytes && bytes + size > 4 * 1024 * 1024) break;
				page.assets.push({
					revision: row.revision,
					path: row.path,
					body: row.body,
				});
				page.cursor = row.cursor;
				bytes += size;
			}
		}
		return page;
	}
	private active() {
		return this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key='active'")
			.toArray()[0]?.value;
	}
	private published() {
		const id = this.active();
		if (!id) return;
		const row = this.ctx.storage.sql
			.exec<{ bundle: string; detail: string }>(
				'SELECT bundle,detail FROM builds WHERE id=?',
				id,
			)
			.toArray()[0];
		if (!row?.bundle) return;
		const detail = JSON.parse(row.detail);
		if (detail.apiVersion !== '0.4.0') return;
		return { id, code: JSON.parse(row.bundle), actions: detail.actions };
	}

	peek(path: string) {
		this.checkPath(path);
		return (
			this.ctx.storage.sql
				.exec<{ text: string; version: number }>(
					'SELECT text,version FROM files WHERE path=?',
					path,
				)
				.toArray()[0] ?? {
				text: null,
				version:
					this.ctx.storage.sql
						.exec<{ version: number }>(
							'SELECT version FROM file_versions WHERE path=?',
							path,
						)
						.toArray()[0]?.version ?? 0,
			}
		);
	}
	write(path: string, text: string) {
		this.checkPath(path);
		this.ctx.storage.transactionSync(() => {
			const version = this.peek(path).version + 1;
			this.ctx.storage.sql.exec(
				'INSERT OR REPLACE INTO file_versions VALUES(?,?)',
				path,
				version,
			);
			this.ctx.storage.sql.exec(
				'INSERT INTO files VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET text=excluded.text,version=excluded.version',
				path,
				text,
				version,
			);
		});
	}

	replace(path: string, version: number, text: string) {
		const before = this.peek(path);
		if (before.version !== version) return false;
		this.write(path, text);
		return true;
	}
	remove(path: string) {
		this.checkPath(path);
		this.ctx.storage.transactionSync(() => {
			const version = this.peek(path).version + 1;
			this.ctx.storage.sql.exec(
				'INSERT OR REPLACE INTO file_versions VALUES(?,?)',
				path,
				version,
			);
			this.ctx.storage.sql.exec('DELETE FROM files WHERE path=?', path);
		});
	}

	list(dir = 'data') {
		return this.ctx.storage.sql
			.exec<{ path: string }>('SELECT path FROM files ORDER BY path')
			.toArray()
			.map((row) => row.path)
			.filter((at) => at.startsWith(dir.replace(/\/$/, '') + '/'));
	}
	private checkPath(path: string) {
		if (
			!path.startsWith('data/') ||
			path.split('/').some((part) => part === '..' || part.startsWith('.git'))
		)
			throw new Error('Only prototype task data paths are allowed');
	}
	source(): Pick<Source, 'read' | 'list'> {
		return {
			read: (at) =>
				at === 'server.ts'
					? serverSource
					: (this.ctx.storage.sql
							.exec<{ text: string }>(
								'SELECT text FROM source WHERE path=?',
								at,
							)
							.toArray()[0]?.text ?? null),
			list: (prefix = '') =>
				this.ctx.storage.sql
					.exec<{ path: string }>('SELECT path FROM source ORDER BY path')
					.toArray()
					.map((row) => row.path)
					.filter((at) => at.startsWith(prefix)),
		};
	}
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/admin/runs') return json(this.runs.list());
		if (
			url.pathname === '/admin/interrupt' &&
			request.method === 'POST' &&
			this.env.TEST_INTERRUPTION === 'true'
		) {
			await request.text();
			this.ctx.abort('Forced interruption of the scratch prototype');
		}
		if (url.pathname === '/admin/source' && request.method === 'GET') {
			const path = url.searchParams.get('path') ?? 'epicenter.ts';
			const fs = this.source();
			return json({
				path,
				text: fs.read(path),
				paths: fs
					.list()
					.filter(
						(p) => !p.startsWith('node_modules/') && !p.startsWith('runtime/'),
					),
			});
		}
		if (url.pathname === '/admin/preview' && request.method === 'GET') {
			const revision = this.active();
			if (!revision) return json({ error: 'Provision your home first.' }, 404);
			const read = (path: string) =>
				this.ctx.storage.sql
					.exec<{ body: ArrayBuffer }>(
						'SELECT body FROM assets WHERE revision=? AND path=?',
						revision,
						path,
					)
					.toArray()[0]?.body;
			const fonts = Object.fromEntries(
				this.ctx.storage.sql
					.exec<{ path: string; body: ArrayBuffer }>(
						"SELECT path,body FROM assets WHERE revision=? AND path LIKE '/fonts/%'",
						revision,
					)
					.toArray()
					.map((row) => [row.path, Buffer.from(row.body).toString('base64')]),
			);
			return json({
				revision,
				js: new TextDecoder().decode(read('/main.js')),
				css: new TextDecoder().decode(read('/app.css')),
				fonts,
			});
		}
		if (url.pathname.startsWith('/.runs/')) {
			const result = await this.runs.handle(request, url.pathname);
			if (result) return result;
		}
		if (url.pathname === '/admin/status')
			return json({
				active: this.active() ?? null,
				building: this.building,
				sourceFiles: this.ctx.storage.sql
					.exec<{ n: number }>('SELECT COUNT(*) AS n FROM source')
					.toArray()[0].n,
				builds: this.ctx.storage.sql
					.exec<{ id: string; detail: string }>(
						'SELECT id,detail FROM builds ORDER BY rowid DESC LIMIT 8',
					)
					.toArray()
					.map((row) => ({ id: row.id, ...JSON.parse(row.detail) })),
			});
		if (url.pathname === '/admin/data')
			return json(
				this.ctx.storage.sql
					.exec('SELECT * FROM files ORDER BY path')
					.toArray(),
			);
		if (url.pathname === '/admin/source' && request.method === 'POST') {
			if (this.building) return json({ error: 'Build in progress' }, 409);
			const { files } = (await request.json()) as {
				files: Record<string, string>;
			};
			if (this.building) return json({ error: 'Build in progress' }, 409);
			if (
				!files ||
				typeof files !== 'object' ||
				Array.isArray(files) ||
				Object.entries(files).some(
					([at, text]) =>
						!at ||
						at.startsWith('/') ||
						at.startsWith('data/') ||
						at.includes('\\') ||
						at.split('/').some((p) => p === '..' || p.startsWith('.git')) ||
						typeof text !== 'string' ||
						Buffer.byteLength(text) > 4 * 1024 * 1024,
				)
			)
				return json({ error: 'Invalid source files' }, 400);
			this.ctx.storage.transactionSync(() => {
				for (const [at, text] of Object.entries(files)) {
					this.ctx.storage.sql.exec(
						'INSERT OR REPLACE INTO source VALUES(?,?)',
						at,
						text,
					);
				}
			});
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO meta VALUES('source-version',?)",
				crypto.randomUUID(),
			);
			return json({ uploaded: Object.keys(files).length });
		}
		if (url.pathname === '/admin/static' && request.method === 'POST') {
			const { files } = (await request.json()) as {
				files: Record<string, string>;
			};
			if (this.building) return json({ error: 'Build in progress' }, 409);
			for (const [at, base64] of Object.entries(files))
				this.ctx.storage.sql.exec(
					'INSERT OR REPLACE INTO assets VALUES(?,?,?)',
					'static',
					at,
					Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
				);
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO meta VALUES('source-version',?)",
				crypto.randomUUID(),
			);
			return json({ uploaded: Object.keys(files).length });
		}
		if (url.pathname === '/admin/build' && request.method === 'POST') {
			await request.text();
			if (this.building) return json({ error: 'Build in progress' }, 409);
			this.building = true;
			const id = crypto.randomUUID();
			const started = Date.now();
			try {
				const fs = this.source();
				const manifest = [...fs.list(), 'server.ts'];
				const initial: Record<string, string> = {};
				for (const at of manifest)
					if (
						at === 'server.ts' ||
						at === 'epicenter.ts' ||
						at.startsWith('ui/') ||
						at.startsWith('runtime/') ||
						at.endsWith('/package.json') ||
						at.endsWith('.css')
					)
						initial[at] = fs.read(at)!;
				const compiler = this.env.LOADER.load(compilerCode);
				const result = await compiler
					.getEntrypoint<Compiler>('Compiler')
					.compile(manifest, initial, new SourceReader(this));
				const code = {
					...result.server,
					compatibilityDate: '2026-11-15',
					compatibilityFlags: ['nodejs_compat'],
					globalOutbound: null,
				};
				const worker = this.env.LOADER.get(`tasks:${id}`, () => code);
				let actions;
				try {
					actions = await worker
						.getEntrypoint<HostedActions>('Actions')
						.describe();
				} catch (error) {
					const message = String(error);
					const line = Number(/bundle.js:(\d+)/.exec(message)?.[1]);
					const m = result.server.modules[result.server.mainModule];
					const text = typeof m === 'string' ? m : (m.js ?? '');
					throw new Error(
						message +
							'\nSOURCE: ' +
							text
								.split('\n')
								.slice(Math.max(0, line - 4), line + 2)
								.join('\n'),
					);
				}
				const detail = {
					ok: true,
					apiVersion: '0.4.0',
					runtime: 'workerd',
					compiler: result.compiler,
					components: result.components,
					elapsedMs: Date.now() - started,
					actions,
				};
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						'INSERT INTO assets SELECT ?,path,body FROM assets WHERE revision=?',
						id,
						'static',
					);
					for (const [at, body] of Object.entries(result.assets))
						this.ctx.storage.sql.exec(
							'INSERT INTO assets VALUES(?,?,?)',
							id,
							at,
							encoder.encode(body),
						);
					this.ctx.storage.sql.exec(
						'INSERT INTO builds VALUES(?,?,?)',
						id,
						JSON.stringify(code),
						JSON.stringify(detail),
					);
					this.ctx.storage.sql.exec(
						"INSERT OR REPLACE INTO meta VALUES('active',?)",
						id,
					);
				});
				return json({ id, ...detail });
			} catch (error) {
				const detail = {
					ok: false,
					runtime: 'workerd',
					error: error instanceof Error ? error.message : String(error),
				};
				this.ctx.storage.sql.exec(
					'INSERT INTO builds VALUES(?,NULL,?)',
					id,
					JSON.stringify(detail),
				);
				return json({ id, ...detail, active: this.active() ?? null }, 422);
			} finally {
				this.building = false;
			}
		}
		const active = this.active();
		if (url.pathname === '/' || url.pathname === '/tasks/')
			return active
				? Response.redirect(`${url.origin}/tasks~${active}/`, 302)
				: json({ error: 'No successful build yet' }, 404);
		const match = /^\/tasks~([^/]+)\/(.*)$/.exec(url.pathname);
		if (!match || !active) return json({ error: 'Not found' }, 404);
		const [, revision, rest] = match;
		if (rest.startsWith('.runs/')) {
			const result = await this.runs.handle(request, '/' + rest, revision);
			if (result) return result;
		}
		if (revision !== active)
			return json(
				{ error: 'App updated. Reload before starting another call.', active },
				409,
			);
		if (request.method !== 'GET')
			return json({ error: 'Use the current .runs API' }, 404);
		const at = rest ? '/' + rest : '/index.html';
		const row = this.ctx.storage.sql
			.exec<{ body: ArrayBuffer }>(
				'SELECT body FROM assets WHERE revision=? AND path=?',
				revision,
				at,
			)
			.toArray()[0];
		return row
			? new Response(row.body, {
					headers: {
						'Content-Type': mime(at),
						'Cache-Control': 'no-store',
						'X-App-Revision': revision,
					},
				})
			: json({ error: 'Asset not found', at }, 404);
	}
}
class SourceReader extends RpcTarget {
	constructor(private owner: TasksOwner) {
		super();
	}
	read(path: string) {
		return this.owner.source().read(path);
	}
}

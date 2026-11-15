// Throwaway Tasks proof. No production authentication, tenants, or scheduling product.
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { compilerCode } from '../compiler-artifact/loader.js';
import type { Source } from './build.js';
import type { Compiler } from './compiler.js';
import type { HostedActions } from './hosted-actions.js';
import { serverSource } from './server-source.js';

type Env = {
	OWNER: DurableObjectNamespace<TasksOwner>;
	LOADER: WorkerLoader;
	ADMIN_TOKEN: string;
};
const encoder = new TextEncoder();
async function digest(value: string) {
	return [
		...new Uint8Array(
			await crypto.subtle.digest('SHA-256', encoder.encode(value)),
		),
	]
		.map((n) => n.toString(16).padStart(2, '0'))
		.join('');
}
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

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		if (url.pathname === '/health')
			return json({
				prototype: 'tasks-workers',
				runtime: 'workerd',
				containers: false,
			});
		if (!env.ADMIN_TOKEN)
			return json({ error: 'Prototype secret not configured' }, 503);
		const cookie = `prototype_session=${await digest(env.ADMIN_TOKEN)}`;
		if (url.pathname === '/session' && request.method === 'POST') {
			const { token } = (await request.json()) as { token: string };
			return token === env.ADMIN_TOKEN
				? new Response(null, {
						status: 204,
						headers: {
							'Set-Cookie': `${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/`,
						},
					})
				: json({ error: 'Unauthorized' }, 401);
		}
		const authorized =
			request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}` ||
			request.headers
				.get('Cookie')
				?.split(';')
				.some((part) => part.trim() === cookie);
		if (!authorized)
			return json({ error: 'Prototype requires authorization' }, 401);
		return env.OWNER.getByName('tasks-proof').fetch(request);
	},
} satisfies ExportedHandler<Env>;

export class TasksOwner extends DurableObject<Env> {
	private building = false;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS source(path TEXT PRIMARY KEY,text TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,text TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS assets(revision TEXT,path TEXT,body BLOB,PRIMARY KEY(revision,path)); CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY,bundle TEXT,detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
		);
	}
	private active() {
		return this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key='active'")
			.toArray()[0]?.value;
	}
	peek(path: string) {
		this.checkPath(path);
		return (
			this.ctx.storage.sql
				.exec<{ text: string; version: number }>(
					'SELECT text,version FROM files WHERE path=?',
					path,
				)
				.toArray()[0] ?? { text: null, version: 0 }
		);
	}
	write(path: string, text: string) {
		this.checkPath(path);
		this.ctx.storage.sql.exec(
			'INSERT INTO files VALUES(?,?,1) ON CONFLICT(path) DO UPDATE SET text=excluded.text,version=version+1',
			path,
			text,
		);
	}
	replace(path: string, version: number, text: string) {
		const before = this.peek(path);
		if (before.version !== version) return false;
		this.write(path, text);
		return true;
	}
	remove(path: string) {
		this.checkPath(path);
		this.ctx.storage.sql.exec('DELETE FROM files WHERE path=?', path);
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
			this.ctx.storage.transactionSync(() => {
				for (const [at, text] of Object.entries(files)) {
					if (at.startsWith('data/') || at.includes('..'))
						throw new Error('Invalid source path');
					this.ctx.storage.sql.exec(
						'INSERT OR REPLACE INTO source VALUES(?,?)',
						at,
						text,
					);
				}
			});
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
					compatibilityDate: '2026-08-01',
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
		if (revision !== active)
			return json(
				{ error: 'App updated. Reload before making another call.', active },
				409,
			);
		if (request.method === 'POST') {
			const input = await request.json();
			const invoke = async () => {
				const row = this.ctx.storage.sql
					.exec<{ bundle: string }>(
						'SELECT bundle FROM builds WHERE id=?',
						revision,
					)
					.toArray()[0];
				const worker = this.env.LOADER.get(`tasks:${revision}`, () =>
					JSON.parse(row.bundle),
				);
				const answer = await worker
					.getEntrypoint<HostedActions>('Actions')
					.run(rest.replace(/\//g, '.'), input, new TaskFiles(this));
				return new Response(JSON.stringify({ answer }) + '\n', {
					headers: {
						'Content-Type': 'application/x-ndjson',
						'X-App-Revision': revision,
					},
				});
			};
			const result = this.queue.then(invoke, invoke);
			this.queue = result.then(
				() => {},
				() => {},
			);
			return result;
		}
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
class TaskFiles extends RpcTarget {
	constructor(private owner: TasksOwner) {
		super();
	}
	peek(path: string) {
		return this.owner.peek(path);
	}
	write(path: string, text: string) {
		return this.owner.write(path, text);
	}
	replace(path: string, version: number, text: string) {
		return this.owner.replace(path, version, text);
	}
	remove(path: string) {
		return this.owner.remove(path);
	}
	list(dir?: string) {
		return this.owner.list(dir);
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

// Disposable host for the real 0.4 client protocol. Only synthetic Tasks data.
import { RpcTarget } from 'cloudflare:workers';
import { Value } from 'typebox/value';
import type { HostedActions, Description } from './hosted-actions.js';

type RunRow = {
	id: string;
	app: string;
	action: string;
	revision: string;
	digest: string | null;
	state: string;
	epoch: string;
	cancelled: number;
	created: string;
};
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, stable(item)]),
		);
	return value;
}
export type Files = {
	peek(path: string): { text: string | null; version: number };
	replace(path: string, version: number, text: string): boolean;
	write(path: string, text: string): void;
	remove(path: string): void;
	list(dir?: string): string[];
};
export class RunHost {
	readonly epoch = crypto.randomUUID();
	private cancellation = new Map<string, Set<(cancelled: boolean) => void>>();
	constructor(
		private ctx: DurableObjectState,
		private loader: WorkerLoader,
		private files: Files,
		private published: () =>
			| {
					id: string;
					code: WorkerLoaderWorkerCode;
					actions: Record<string, Description>;
			  }
			| undefined,
	) {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS runs04(id TEXT PRIMARY KEY,app TEXT,action TEXT,revision TEXT,digest TEXT,state TEXT,epoch TEXT,cancelled INTEGER,created TEXT); CREATE TABLE IF NOT EXISTS events04(run TEXT,seq INTEGER,event TEXT,PRIMARY KEY(run,seq));`,
		);
		for (const row of this.sql
			.exec<RunRow>(
				"SELECT * FROM runs04 WHERE state IN ('accepted','running')",
			)
			.toArray())
			this.append(row.id, {
				type: 'interrupted',
				message:
					'The host restarted before this run finished. It was not run again; earlier effects may remain.',
			});
	}
	private get sql() {
		return this.ctx.storage.sql;
	}
	row(id: string) {
		return this.sql
			.exec<RunRow>('SELECT * FROM runs04 WHERE id=?', id)
			.toArray()[0];
	}
	list() {
		return this.sql
			.exec<RunRow>('SELECT * FROM runs04 ORDER BY rowid DESC LIMIT 60')
			.toArray()
			.map(({ digest, epoch, ...row }) => row);
	}
	private terminal(row: RunRow) {
		return row.state === 'finished' || row.state === 'interrupted';
	}
	assert(id: string) {
		const row = this.row(id);
		if (!row || row.epoch !== this.epoch || this.terminal(row))
			throw new Error('This execution no longer owns the run');
		return row;
	}
	cancelled(id: string) {
		const row = this.row(id);
		return (
			!row ||
			row.epoch !== this.epoch ||
			this.terminal(row) ||
			Boolean(row.cancelled)
		);
	}
	whenCancelled(id: string) {
		if (this.cancelled(id)) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const set = this.cancellation.get(id) ?? new Set();
			set.add(resolve);
			this.cancellation.set(id, set);
		});
	}
	releaseCancellation(id: string, cancelled = false) {
		const set = this.cancellation.get(id);
		this.cancellation.delete(id);
		for (const resolve of set ?? []) resolve(cancelled);
	}
	append(id: string, body: Record<string, unknown>) {
		return this.ctx.storage.transactionSync(() => {
			const seq = this.sql
				.exec<{ seq: number }>(
					'SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events04 WHERE run=?',
					id,
				)
				.toArray()[0].seq;
			const event = { ...body, seq, at: new Date().toISOString() };
			const text = JSON.stringify(event);
			if (new TextEncoder().encode(text).byteLength > 256 * 1024)
				throw new Error('A yield exceeds the prototype event limit');
			this.sql.exec('INSERT INTO events04 VALUES(?,?,?)', id, seq, text);
			if (['started', 'finished', 'interrupted'].includes(String(body.type)))
				this.sql.exec(
					'UPDATE runs04 SET state=? WHERE id=?',
					body.type === 'started' ? 'running' : String(body.type),
					id,
				);
			return event;
		});
	}
	private refusal(message: string, status = 400, admitted = false) {
		return Response.json(
			{
				data: null,
				error: { kind: 'refused', reason: { name: 'Refused', message } },
			},
			{ status, headers: { 'X-Epicenter-Admitted': String(admitted) } },
		);
	}
	private async digest(input: unknown) {
		const bytes = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(stable(input))),
		);
		return Array.from(new Uint8Array(bytes), (n) =>
			n.toString(16).padStart(2, '0'),
		).join('');
	}
	private requestCancel(id: string) {
		const row = this.row(id);
		if (!row || this.terminal(row)) return false;
		if (!row.cancelled)
			this.ctx.storage.transactionSync(() => {
				this.sql.exec('UPDATE runs04 SET cancelled=1 WHERE id=?', id);
				this.append(id, { type: 'cancel-requested' });
			});
		this.releaseCancellation(id, true);
		return true;
	}
	private async execute(
		row: RunRow,
		input: unknown,
		code: WorkerLoaderWorkerCode,
	) {
		const timer = setTimeout(() => this.requestCancel(row.id), 120000);
		try {
			this.assert(row.id);
			this.append(row.id, { type: 'started' });
			const worker = this.loader.get(
				`tasks04:${this.ctx.id}:${row.revision}`,
				() => code,
			);
			const answer = await worker
				.getEntrypoint<HostedActions>('Actions')
				.run(
					row.action,
					input,
					new RunFiles(this, row.id, this.files),
					new RunSink(this, row.id),
				);
			this.assert(row.id);
			this.append(row.id, { type: 'finished', answer });
		} catch (error) {
			const current = this.row(row.id);
			if (current && !this.terminal(current) && current.epoch === this.epoch)
				this.append(row.id, {
					type: 'interrupted',
					message: `The run could not finish: ${error instanceof Error ? error.message : String(error)}. It was not run again; earlier effects may remain.`,
				});
		} finally {
			clearTimeout(timer);
			this.releaseCancellation(row.id);
		}
	}
	private events(request: Request, row: RunRow, after: number) {
		let timer: ReturnType<typeof setInterval> | undefined;
		let stopped = false;
		const stop = () => {
			stopped = true;
			clearInterval(timer);
			request.signal.removeEventListener('abort', stop);
		};
		let cursor = after;
		const body = new ReadableStream<Uint8Array>({
			type: 'bytes',
			start: (controller) => {
				const read = () => {
					if (stopped) return;
					try {
						const events = this.sql
							.exec<{ seq: number; event: string }>(
								'SELECT seq,event FROM events04 WHERE run=? AND seq>? ORDER BY seq',
								row.id,
								cursor,
							)
							.toArray();
						for (const event of events) {
							controller.enqueue(new TextEncoder().encode(event.event + '\n'));
							cursor = event.seq;
						}
						const latest = this.row(row.id);
						if (!latest || this.terminal(latest)) {
							stop();
							controller.close();
						}
					} catch (error) {
						stop();
						controller.error(error);
					}
				};
				timer = setInterval(read, 150);
				request.signal.addEventListener('abort', stop, { once: true });
				read();
			},
			cancel: stop,
		});
		return new Response(body, {
			headers: {
				'Content-Type': 'application/x-ndjson',
				'Cache-Control': 'no-store',
				'X-Epicenter-Admitted': 'true',
			},
		});
	}
	async handle(
		request: Request,
		path: string,
		revision?: string,
	): Promise<Response | undefined> {
		const match =
			/^\/\.runs\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
		if (!match) return;
		const [, app, action, id, operation] = match;
		if (
			app !== 'tasks' ||
			!/^[a-zA-Z0-9.-]+$/.test(action) ||
			!/^[-a-zA-Z0-9]{1,80}$/.test(id)
		)
			return this.refusal('Invalid run address');
		let row = this.row(id);
		if (row && (row.app !== app || row.action !== action))
			return this.refusal('This run id belongs to another action', 409);
		if (request.method === 'POST' && !operation) {
			let input: unknown;
			try {
				input = await request.json();
			} catch {
				return this.refusal('Input must be JSON');
			}
			const current = this.published();
			if (!current) return this.refusal('No published app', 503);
			const description = current.actions[action];
			if (!description) return this.refusal('Unknown action', 404);
			const digest = description.privateInput ? null : await this.digest(input);
			// Awaited hashing may have allowed another request to admit the same id.
			row = this.row(id);
			if (row) {
				if (row.app !== app || row.action !== action || row.digest !== digest)
					return this.refusal(
						'This run id was accepted with different input or action',
						409,
					);
				return this.events(request, row, 0);
			}
			if (revision && revision !== current.id)
				return this.refusal(
					'App updated. Reload before starting another run.',
					409,
				);
			if (
				!(
					Value.Check as unknown as (schema: unknown, value: unknown) => boolean
				)(description.schema, input)
			)
				return this.refusal('The input does not fit this action');
			const active = this.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM runs04 WHERE state IN ('accepted','running')",
				)
				.toArray()[0].n;
			if (active >= 16)
				return this.refusal('Sixteen runs are already active', 429);
			row = {
				id,
				app,
				action,
				revision: current.id,
				digest,
				state: 'accepted',
				epoch: this.epoch,
				cancelled: 0,
				created: new Date().toISOString(),
			};
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					'INSERT INTO runs04 VALUES(?,?,?,?,?,?,?,?,?)',
					row!.id,
					app,
					action,
					row!.revision,
					digest,
					'accepted',
					this.epoch,
					0,
					row!.created,
				);
				this.append(id, { type: 'accepted' });
			});
			this.ctx.waitUntil(this.execute(row, input, current.code));
			return this.events(request, row, 0);
		}
		if (!row) return this.refusal('Unknown run; it was not run again', 404);
		if (request.method === 'POST' && operation === 'cancel') {
			await request.text();
			const active = this.requestCancel(id);
			return Response.json(
				{ state: this.row(id)!.state },
				{ status: active ? 202 : 200 },
			);
		}
		if (request.method === 'GET' && operation === 'events') {
			const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
			if (!Number.isSafeInteger(after) || after < 0)
				return this.refusal('Invalid event cursor');
			return this.events(request, row, after);
		}
		if (request.method === 'GET' && !operation) {
			const { digest, epoch, ...status } = row;
			return Response.json(status);
		}
		return this.refusal('Method not allowed', 405);
	}
}
class RunFiles extends RpcTarget {
	constructor(
		private host: RunHost,
		private id: string,
		private files: Files,
	) {
		super();
	}
	peek(path: string) {
		this.host.assert(this.id);
		return this.files.peek(path);
	}
	replace(path: string, version: number, text: string) {
		this.host.assert(this.id);
		return this.files.replace(path, version, text);
	}
	write(path: string, text: string) {
		this.host.assert(this.id);
		return this.files.write(path, text);
	}
	remove(path: string) {
		this.host.assert(this.id);
		return this.files.remove(path);
	}
	list(dir?: string) {
		this.host.assert(this.id);
		return this.files.list(dir);
	}
}
class RunSink extends RpcTarget {
	constructor(
		private host: RunHost,
		private id: string,
	) {
		super();
	}
	yield(value: unknown) {
		this.host.assert(this.id);
		const json = JSON.stringify(value);
		if (json === undefined) throw new Error('A run yield must be a JSON value');
		this.host.append(this.id, { type: 'yielded', value: JSON.parse(json) });
	}
	whenCancelled() {
		return this.host.whenCancelled(this.id);
	}
	releaseCancellation() {
		this.host.releaseCancellation(this.id);
	}
}

/**
 * PROTOTYPE: Can serve own a run that outlives its HTTP observer, with binary
 * file inputs persisted outside Git? This throwaway host has one process,
 * cooperative cancellation, no reruns after recovery, and bounded local files
 * (15 MiB/file, 512 MiB upload admission budget, 8 active runs, 64 observers,
 * 24-hour retention).
 * Input bytes are deleted after a returned finish; other outcomes keep them until TTL.
 * See packages/cli/prototype/runs-demo/NOTES.md for the experiment.
 */
import {
	chmod,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	type FileHandle,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
	type Action,
	FILE_REFERENCE_PREFIX,
	fileFieldOf,
	isName,
	MAX_FILE_BYTES,
	type UploadedFile,
} from '@epicenter/app';
import { CliError } from './errors.ts';
import { homeEntries, loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { type Answer, writeErr } from './output.ts';
import { epicenterDir, folderPath } from './root.ts';
import { runAction } from './run.ts';

const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_YIELD_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
// Keep a durable terminal answer possible even when yields reach the log limit.
const TERMINAL_RESERVE_BYTES = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RECOVERY_MESSAGE =
	'Epicenter stopped before this run finished. It was not run again; anything it did before then may have taken effect.';
const ID = /^[A-Za-z0-9_-]{16,64}$/;

type FileMeta = {
	field: string;
	name: string;
	type: string;
	size: number;
	sha256: string;
	reference: string;
	uploadedAt: string;
};
type RunRecord = {
	version: 1;
	id: string;
	app: string;
	action: string;
	inputDigest: string;
	acceptedAt: string;
	state: 'accepted' | 'running' | 'finished' | 'interrupted';
	endedAt?: string;
	files: Record<string, Pick<FileMeta, 'name' | 'type' | 'size' | 'sha256'>>;
};
type EventFields =
	| { type: 'accepted' | 'started' | 'cancel-requested' }
	| { type: 'yielded'; value: unknown }
	| { type: 'finished'; answer: Answer }
	| { type: 'interrupted'; message: string };
type HostEvent = EventFields & { seq: number; at: string };
type RunLocation = {
	app: string;
	id: string;
	action: string;
	dir: string;
	key: string;
};

const terminal = (record: RunRecord) =>
	record.state === 'finished' || record.state === 'interrupted';
const hash = (value: string) =>
	new Bun.CryptoHasher('sha256').update(value).digest('hex');
const hexField = (field: string) => Buffer.from(field, 'utf8').toString('hex');
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const usage = (status: number, message: string, next?: string) =>
	Response.json({ error: CliError.Usage({ message, next }).error }, { status });
const missing = () => usage(404, 'Unknown run route or run');

function withinRoot(path: string, root: string) {
	const rel = relative(root, path);
	return (
		rel === '' ||
		(rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
	);
}

/** Resolve missing path segments through their nearest existing ancestor before mkdir. */
async function prospectiveRealpath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
		const parent = dirname(path);
		if (parent === path) throw cause;
		return join(
			await prospectiveRealpath(parent),
			path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
		);
	}
}

/** PROTOTYPE: Resolve and create the private runtime directory, refusing app and Epicenter paths before writing. */
export async function resolveRuntimeDir(): Promise<string> {
	const root = await realpath(epicenterDir());
	const roots = [root, ...(await homeEntries()).map((entry) => entry.realPath)];
	const requested = folderPath(
		process.env.EPICENTER_RUNTIME_DIR ??
			`~/.local/state/epicenter/prototype-runs/${hash(root).slice(0, 16)}`,
	);
	const check = (path: string) => {
		const containing = roots.find((entry) => withinRoot(path, entry));
		if (containing)
			throw new Error(
				`Runtime directory ${path} is inside ${containing}; choose EPICENTER_RUNTIME_DIR outside the Epicenter and every app`,
			);
	};
	check(await prospectiveRealpath(requested));
	await mkdir(requested, { recursive: true, mode: 0o700 });
	const dir = await realpath(requested);
	check(dir);
	await chmod(dir, 0o700);
	if (process.platform === 'darwin') {
		try {
			await Bun.spawn(['tmutil', 'addexclusion', dir], {
				stdout: 'ignore',
				stderr: 'ignore',
			}).exited;
		} catch {
			/* Time Machine exclusion is best effort. */
		}
	}
	return dir;
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (!object(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stable(value[key])]),
	);
}

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

async function jsonFile<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw cause;
	}
}

async function syncDir(dir: string) {
	const handle = await open(dir, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Write every byte even when an OS write completes only part of its buffer. */
async function writeAll(handle: FileHandle, bytes: Uint8Array) {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			bytes.byteLength - offset,
		);
		if (bytesWritten === 0)
			throw new Error('The runtime file could not be written');
		offset += bytesWritten;
	}
}

export function createRunHost() {
	let dir: string | undefined;
	let unavailable: string | undefined;
	let runtimeBytes = 0;
	let reservedBytes = 0;
	let streams = 0;
	let stopped = false;
	let clock: ReturnType<typeof setInterval> | undefined;
	const locks = new Map<string, Promise<unknown>>();
	const claimed = new Map<
		string,
		{ controller: AbortController; cancelRequested: boolean }
	>();
	const busy = new Map<string, number>();
	const subscribers = new Map<string, Set<(event: HostEvent) => void>>();
	const observers = new Set<() => void>();
	const sequences = new Map<string, number>();

	async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(work);
		locks.set(key, next);
		try {
			return await next;
		} finally {
			if (locks.get(key) === next) locks.delete(key);
		}
	}

	function location(app: string, action: string, id: string): RunLocation {
		if (!dir) throw new Error('Runtime directory is unavailable');
		return {
			app,
			action,
			id,
			key: `${app}/${id}`,
			dir: join(dir, 'runs', app, id),
		};
	}

	async function makeDir(path: string) {
		await mkdir(path, { recursive: true, mode: 0o700 });
		await chmod(path, 0o700);
	}

	async function atomicJson(path: string, value: unknown) {
		const bytes = new TextEncoder().encode(JSON.stringify(value));
		const previous = await stat(path).then(
			(info) => info.size,
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return 0;
				throw cause;
			},
		);
		const tmp = `${path}.part-${crypto.randomUUID()}`;
		const handle = await open(tmp, 'wx', 0o600);
		try {
			await writeAll(handle, bytes);
			await handle.sync();
		} catch (cause) {
			await rm(tmp, { force: true });
			throw cause;
		} finally {
			await handle.close();
		}
		try {
			await rename(tmp, path);
			runtimeBytes += bytes.byteLength - previous;
			await syncDir(dirname(path));
		} finally {
			await rm(tmp, { force: true });
		}
	}

	async function logOf(run: RunLocation): Promise<HostEvent[]> {
		let text: string;
		try {
			text = await readFile(join(run.dir, 'events.ndjson'), 'utf8');
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw cause;
		}
		const lines = text.split('\n');
		const events: HostEvent[] = [];
		for (const [index, line] of lines.entries()) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (
					!object(value) ||
					!Number.isSafeInteger(value.seq) ||
					typeof value.at !== 'string' ||
					![
						'accepted',
						'started',
						'yielded',
						'cancel-requested',
						'finished',
						'interrupted',
					].includes(String(value.type))
				)
					throw new Error('Invalid run log');
				events.push(value as HostEvent);
			} catch (cause) {
				// Recovery appends a newline after a torn tail, leaving that fragment
				// before the next valid event. It never consumes a sequence number.
				if (cause instanceof SyntaxError) continue;
				if (index === lines.length - 1) break;
				throw cause;
			}
		}
		return events;
	}

	/** Caller holds the run mutex; publish only after the append is durable. */
	async function append(
		run: RunLocation,
		fields: EventFields,
		limit = MAX_LOG_BYTES,
	) {
		const path = join(run.dir, 'events.ndjson');
		const seq =
			(sequences.get(run.key) ?? (await logOf(run)).at(-1)?.seq ?? 0) + 1;
		const event = { seq, at: new Date().toISOString(), ...fields } as HostEvent;
		const serialized = JSON.stringify(event);
		const persisted = JSON.parse(serialized) as HostEvent;
		const handle = await open(path, 'a+', 0o600);
		try {
			const { size } = await handle.stat();
			let prefix = '';
			if (size > 0) {
				const last = new Uint8Array(1);
				await handle.read(last, 0, 1, size - 1);
				if (last[0] !== 10) prefix = '\n';
			}
			const bytes = new TextEncoder().encode(`${prefix}${serialized}\n`);
			if (size + bytes.byteLength > limit)
				throw new Error('The run event log would exceed 4 MiB');
			await writeAll(handle, bytes);
			await handle.datasync();
			runtimeBytes += bytes.byteLength;
		} catch (cause) {
			sequences.delete(run.key);
			throw cause;
		} finally {
			await handle.close();
		}
		sequences.set(run.key, seq);
		for (const publish of subscribers.get(run.key) ?? []) publish(persisted);
		return event;
	}

	async function deleteFile(path: string) {
		const size = await stat(path).then(
			(info) => info.size,
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return 0;
				throw cause;
			},
		);
		await rm(path, { force: true });
		runtimeBytes = Math.max(0, runtimeBytes - size);
	}

	async function deleteBins(run: RunLocation) {
		const files = join(run.dir, 'files');
		const entries = await readdir(files).catch(
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return [];
				throw cause;
			},
		);
		for (const name of entries)
			if (name.endsWith('.bin')) await deleteFile(join(files, name));
	}

	async function runDirs() {
		if (!dir) return [];
		const root = join(dir, 'runs');
		const apps = await readdir(root, { withFileTypes: true });
		const runs: RunLocation[] = [];
		for (const app of apps) {
			if (!app.isDirectory() || !isName(app.name)) continue;
			for (const entry of await readdir(join(root, app.name), {
				withFileTypes: true,
			}))
				if (entry.isDirectory() && ID.test(entry.name))
					runs.push(location(app.name, '', entry.name));
		}
		return runs;
	}

	async function sizeOf(
		path: string,
	): Promise<{ bytes: number; newest: number }> {
		const info = await stat(path);
		if (!info.isDirectory()) return { bytes: info.size, newest: info.mtimeMs };
		let bytes = 0;
		let newest = info.mtimeMs;
		for (const entry of await readdir(path, { withFileTypes: true })) {
			if (entry.isSymbolicLink())
				throw new Error(`Unexpected symlink in runtime directory ${path}`);
			const child = await sizeOf(join(path, entry.name));
			bytes += child.bytes;
			newest = Math.max(newest, child.newest);
		}
		return { bytes, newest };
	}

	async function interrupt(
		run: RunLocation,
		record: RunRecord,
		message = RECOVERY_MESSAGE,
	) {
		if (terminal(record)) return;
		const log = await logOf(run);
		const finished = log.findLast(
			(event) => event.type === 'finished' || event.type === 'interrupted',
		);
		if (!finished) await append(run, { type: 'interrupted', message });
		record.state = finished?.type === 'finished' ? 'finished' : 'interrupted';
		record.endedAt = finished?.at ?? new Date().toISOString();
		await atomicJson(join(run.dir, 'record.json'), record);
		if (finished?.type === 'finished' && 'returned' in finished.answer)
			await deleteBins(run);
	}

	async function sweep() {
		return exclusive('$sweep', async () => {
			for (const run of await runDirs()) {
				if (claimed.has(run.key) || busy.has(run.key)) continue;
				await exclusive(run.key, async () => {
					if (claimed.has(run.key) || busy.has(run.key)) return;
					const record = await jsonFile<RunRecord>(
						join(run.dir, 'record.json'),
					);
					const info = await sizeOf(run.dir);
					if (
						(record &&
							terminal(record) &&
							record.endedAt &&
							Date.parse(record.endedAt) < Date.now() - DAY_MS) ||
						(!record && info.newest < Date.now() - HOUR_MS)
					) {
						await rm(run.dir, { recursive: true, force: true });
						runtimeBytes = Math.max(0, runtimeBytes - info.bytes);
						sequences.delete(run.key);
						return;
					}
					for (const folder of [run.dir, join(run.dir, 'files')]) {
						if (await exists(folder))
							for (const name of await readdir(folder)) {
								if (
									name.includes('.part-') &&
									(await stat(join(folder, name))).mtimeMs <
										Date.now() - HOUR_MS
								)
									await deleteFile(join(folder, name));
							}
					}
				});
			}
		});
	}

	const ready = (async () => {
		try {
			dir = await resolveRuntimeDir();
			await makeDir(join(dir, 'runs'));
			runtimeBytes = (await sizeOf(dir)).bytes;
			for (const run of await runDirs()) {
				const record = await jsonFile<RunRecord>(join(run.dir, 'record.json'));
				if (record && !terminal(record))
					await exclusive(run.key, () => interrupt(run, record));
			}
			await sweep();
			if (!stopped) {
				clock = setInterval(
					() => {
						void sweep().catch((cause) =>
							writeErr(`Run cleanup failed: ${String(cause)}`),
						);
					},
					10 * 60 * 1000,
				);
				clock.unref();
			}
		} catch (cause) {
			unavailable = cause instanceof Error ? cause.message : String(cause);
		}
	})();

	async function upload(
		request: Request,
		run: RunLocation,
		field: string,
	): Promise<Response> {
		const loaded = await loadHomeApp(run.app);
		if (loaded.error || !loaded.data.ok) return missing();
		const action = Object.hasOwn(loaded.data.actions, run.action)
			? loaded.data.actions[run.action]
			: undefined;
		const schema =
			action && Object.hasOwn(action.input, field)
				? fileFieldOf(action.input[field])
				: undefined;
		if (!schema) return missing();
		const lengthText = request.headers.get('content-length');
		if (lengthText === null)
			return usage(411, 'A file upload needs content-length');
		if (!/^\d+$/.test(lengthText)) return usage(400, 'Invalid content-length');
		const length = Number(lengthText);
		if (
			!Number.isSafeInteger(length) ||
			length > Math.min(schema.maxBytes, MAX_FILE_BYTES)
		)
			return usage(413, 'The file exceeds its maximum size');
		const type =
			request.headers.get('content-type') || 'application/octet-stream';
		const baseType = type.split(';')[0]?.trim().toLowerCase() ?? '';
		if (
			schema.accept &&
			!schema.accept.some((entry) => {
				const accepted = entry.toLowerCase();
				return (
					accepted === baseType ||
					(accepted.endsWith('/*') &&
						baseType.startsWith(accepted.slice(0, -1)))
				);
			})
		)
			return usage(415, 'The file type is not accepted');
		let name: string;
		try {
			name = decodeURIComponent(
				request.headers.get('x-epicenter-file-name') ?? 'blob',
			).slice(0, 255);
		} catch {
			return usage(400, 'Invalid file name encoding');
		}
		const reserved = await exclusive('$quota', async () => {
			if (runtimeBytes + reservedBytes + length > MAX_RUNTIME_BYTES)
				await sweep();
			if (runtimeBytes + reservedBytes + length > MAX_RUNTIME_BYTES)
				return false;
			reservedBytes += length;
			return true;
		});
		if (!reserved) return usage(507, 'The run runtime directory is full');
		const files = join(run.dir, 'files');
		const hex = hexField(field);
		const part = join(files, `${hex}.part-${crypto.randomUUID()}`);
		let handle: FileHandle | undefined;
		let count = 0;
		let storedBytes = 0;
		try {
			await makeDir(join(dir as string, 'runs', run.app));
			await makeDir(files);
			handle = await open(part, 'wx', 0o600);
			const hasher = new Bun.CryptoHasher('sha256');
			const reader = request.body?.getReader();
			try {
				if (reader)
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						count += value.byteLength;
						if (
							count > length ||
							count > Math.min(schema.maxBytes, MAX_FILE_BYTES)
						)
							return usage(
								413,
								'The file exceeds its declared or maximum size',
							);
						hasher.update(value);
						await writeAll(handle, value);
						runtimeBytes += value.byteLength;
						storedBytes += value.byteLength;
						reservedBytes -= value.byteLength;
					}
			} finally {
				if (reader) {
					void reader.cancel().catch(() => {});
					reader.releaseLock();
				}
			}
			if (count !== length)
				return usage(400, 'The file is shorter than content-length');
			await handle.sync();
			await handle.close();
			handle = undefined;
			const sha256 = hasher.digest('hex');
			return await exclusive(run.key, async () => {
				const metaPath = join(files, `${hex}.json`);
				const existing = await jsonFile<FileMeta>(metaPath);
				if (existing) {
					if (
						existing.size === count &&
						existing.sha256 === sha256 &&
						existing.name === name &&
						existing.type === type
					)
						return Response.json({ reference: existing.reference });
					return usage(
						409,
						'A different file was already uploaded for this run and field',
					);
				}
				if (await exists(join(run.dir, 'record.json')))
					return usage(409, 'This run has already been admitted');
				const reference = `${FILE_REFERENCE_PREFIX}${run.id}:${hex}:${sha256.slice(0, 32)}`;
				await rename(part, join(files, `${hex}.bin`));
				await atomicJson(metaPath, {
					field,
					name,
					type,
					size: count,
					sha256,
					reference,
					uploadedAt: new Date().toISOString(),
				} satisfies FileMeta);
				await syncDir(files);
				return Response.json({ reference });
			});
		} finally {
			try {
				if (handle) await handle.close();
				await deleteFile(part);
			} finally {
				reservedBytes -= length - storedBytes;
			}
		}
	}

	async function admissionBody(
		request: Request,
	): Promise<{ input: Record<string, unknown> } | { response: Response }> {
		const length = request.headers.get('content-length');
		if (
			length !== null &&
			(!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
		)
			return { response: usage(400, 'Invalid content-length') };
		if (length !== null && Number(length) > MAX_INPUT_BYTES)
			return { response: usage(413, 'The run input exceeds 1 MiB') };
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = request.body?.getReader();
		try {
			if (reader)
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > MAX_INPUT_BYTES)
						return { response: usage(413, 'The run input exceeds 1 MiB') };
					chunks.push(value);
				}
		} finally {
			if (reader) {
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		if (length !== null && Number(length) !== size)
			return {
				response: usage(
					400,
					'The run input length does not match content-length',
				),
			};
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
			return object(input)
				? { input }
				: { response: usage(400, 'The input is not a JSON object') };
		} catch {
			return { response: usage(400, 'The input is not valid JSON') };
		}
	}

	async function execute(
		run: RunLocation,
		record: RunRecord,
		located: Runnable,
		action: Action,
		input: Record<string, unknown>,
		controller: AbortController,
	) {
		try {
			await exclusive(run.key, async () => {
				await append(run, { type: 'started' });
				record.state = 'running';
				await atomicJson(join(run.dir, 'record.json'), record);
			});
			let answer: Answer;
			try {
				const result = await runAction(located, run.action, action, input, {
					signal: controller.signal,
					onYield: async (value) => {
						const json = JSON.stringify(value);
						if (json === undefined)
							throw new Error('A run yield must be a JSON value');
						if (Buffer.byteLength(json) > MAX_YIELD_BYTES)
							throw new Error('A run yield exceeds 256 KiB');
						await exclusive(run.key, () =>
							append(
								run,
								{ type: 'yielded', value: JSON.parse(json) },
								MAX_LOG_BYTES - TERMINAL_RESERVE_BYTES,
							),
						);
					},
				});
				answer = result.answer;
			} catch (cause) {
				answer = { error: CliError.Internal({ cause }).error };
			}
			await exclusive(run.key, async () => {
				try {
					await append(run, { type: 'finished', answer });
				} catch (cause) {
					if (
						!(cause instanceof Error) ||
						cause.message !== 'The run event log would exceed 4 MiB'
					)
						throw cause;
					// An oversized return value still leaves a bounded terminal envelope.
					answer = {
						error: CliError.Usage({
							message: 'The run answer could not fit in its 4 MiB event log',
						}).error,
					};
					await append(run, { type: 'finished', answer });
				}
				record.state = 'finished';
				record.endedAt = new Date().toISOString();
				await atomicJson(join(run.dir, 'record.json'), record);
				if ('returned' in answer) await deleteBins(run);
			});
		} catch (cause) {
			try {
				await exclusive(run.key, async () => {
					// A finished log is already definitive, even if its record update failed.
					const persisted = await jsonFile<RunRecord>(
						join(run.dir, 'record.json'),
					);
					await interrupt(
						run,
						persisted ?? { ...record, state: 'running' },
						`Epicenter could not finish this run: ${String(cause).slice(0, 256)}. It was not run again; earlier effects may have taken place.`,
					);
				});
			} catch (failure) {
				writeErr(
					`Could not persist the end of run ${run.id}: ${String(failure)}; original failure: ${String(cause)}`,
				);
			}
		} finally {
			claimed.delete(run.key);
		}
	}

	async function admit(request: Request, run: RunLocation): Promise<Response> {
		const body = await admissionBody(request);
		if ('response' in body) return body.response;
		const loaded = await loadHomeApp(run.app);
		if (loaded.error) return missing();
		const located = loaded.data;
		if (!located.ok)
			return Response.json(
				{
					error: CliError.AppProblems({
						app: run.app,
						problems: located.problems,
					}).error,
				},
				{ status: 400 },
			);
		const action = Object.hasOwn(located.actions, run.action)
			? located.actions[run.action]
			: undefined;
		if (!action) return missing();
		const checked = checkInput(action, body.input, (key) => key, {
			fileReferences: true,
		});
		if ('error' in checked)
			return usage(
				400,
				checked.error,
				`epicenter ${run.app} ${run.action} --help`,
			);
		const inputDigest = hash(
			JSON.stringify(stable({ action: run.action, input: checked.input })),
		);
		if ((await runDirs()).length >= 1000) await sweep();
		return exclusive(run.key, () =>
			exclusive('$admissions', async () => {
				const existing = await jsonFile<RunRecord>(
					join(run.dir, 'record.json'),
				);
				if (existing) {
					if (
						existing.action === run.action &&
						existing.inputDigest === inputDigest
					)
						return Response.json({ id: run.id, state: existing.state });
					return usage(
						409,
						'This run id was already admitted with different input or action',
					);
				}
				const files = Object.create(null) as RunRecord['files'];
				const decoded = { ...checked.input };
				for (const [field, schema] of Object.entries(action.input)) {
					if (!fileFieldOf(schema) || checked.input[field] === undefined)
						continue;
					const hex = hexField(field);
					const meta = await jsonFile<FileMeta>(
						join(run.dir, 'files', `${hex}.json`),
					);
					const binPath = join(run.dir, 'files', `${hex}.bin`);
					if (
						!meta ||
						checked.input[field] !== meta.reference ||
						!(await exists(binPath))
					)
						return usage(
							400,
							`The file for ${field} was not uploaded for this run`,
						);
					const { name, type, size, sha256 } = meta;
					files[field] = { name, type, size, sha256 };
					decoded[field] = Object.freeze({
						name,
						type,
						size,
						path: () => binPath,
						bytes: async () =>
							new Uint8Array(await Bun.file(binPath).arrayBuffer()),
						text: () => Bun.file(binPath).text(),
						toJSON: () => ({ name, type, size }),
					} satisfies UploadedFile & {
						toJSON(): { name: string; type: string; size: number };
					});
				}
				if (claimed.size >= 8)
					return usage(503, 'Eight runs are already active on this host');
				const count = (await runDirs()).length;
				if (count > 1000 || (count === 1000 && !(await exists(run.dir))))
					return usage(507, 'The runtime directory has too many runs');
				await makeDir(join(dir as string, 'runs', run.app));
				await makeDir(run.dir);
				const record: RunRecord = {
					version: 1,
					id: run.id,
					app: run.app,
					action: run.action,
					inputDigest,
					acceptedAt: new Date().toISOString(),
					state: 'accepted',
					files,
				};
				await atomicJson(join(run.dir, 'record.json'), record);
				await append(run, { type: 'accepted' });
				await syncDir(run.dir);
				const controller = new AbortController();
				claimed.set(run.key, { controller, cancelRequested: false });
				// Detached from request.signal: only explicit cancellation owns this signal.
				void execute(run, record, located, action, decoded, controller).catch(
					(cause) => writeErr(`Run executor failed: ${String(cause)}`),
				);
				return Response.json(
					{ id: run.id, state: 'accepted' },
					{ status: 202 },
				);
			}),
		);
	}

	async function recordOf(run: RunLocation) {
		const record = await jsonFile<RunRecord>(join(run.dir, 'record.json'));
		if (
			!record ||
			record.app !== run.app ||
			record.id !== run.id ||
			record.action !== run.action
		)
			return undefined;
		if (!terminal(record) && !claimed.has(run.key))
			await interrupt(run, record);
		return record;
	}

	async function events(
		request: Request,
		run: RunLocation,
		record: RunRecord,
	): Promise<Response> {
		const after = new URL(request.url).searchParams.get('after') ?? '0';
		if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
			return usage(400, 'after must be a non-negative integer');
		if (streams >= 64)
			return usage(503, 'Too many run observers are connected');
		streams++;
		let cursor = Number(after);
		let closed = false;
		let replaying = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const queued: HostEvent[] = [];
		const encoder = new TextEncoder();
		const isTerminal = (event: HostEvent) =>
			event.type === 'finished' || event.type === 'interrupted';
		const cleanup = () => {
			if (closed) return;
			closed = true;
			streams--;
			clearTimeout(timer);
			subscribers.get(run.key)?.delete(publish);
			if (subscribers.get(run.key)?.size === 0) subscribers.delete(run.key);
			observers.delete(close);
			request.signal.removeEventListener('abort', close);
		};
		const close = () => {
			if (closed) return;
			cleanup();
			controller.close();
		};
		const send = (event: HostEvent) => {
			if (closed) return;
			if (event.seq > cursor) {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				cursor = event.seq;
			}
			if (isTerminal(event)) close();
		};
		const publish = (event: HostEvent) => {
			if (replaying) queued.push(event);
			else send(event);
		};
		const stream = new ReadableStream<Uint8Array>({
			start(owner) {
				controller = owner;
			},
			cancel() {
				cleanup();
			},
		});
		const listening = subscribers.get(run.key) ?? new Set();
		listening.add(publish);
		subscribers.set(run.key, listening);
		observers.add(close);
		request.signal.addEventListener('abort', close, { once: true });
		timer = setTimeout(close, 55_000);
		timer.unref();
		try {
			// Subscribe before replay. The cursor removes overlap with queued live events.
			for (const event of await logOf(run)) send(event);
			replaying = false;
			for (const event of queued.sort((a, b) => a.seq - b.seq)) send(event);
			if (terminal(record) || request.signal.aborted) close();
		} catch (cause) {
			cleanup();
			controller.error(cause);
		}
		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'cache-control': 'no-store',
			},
		});
	}

	return {
		ready,
		runtimeDir() {
			return dir;
		},
		async handle(request: Request): Promise<Response> {
			await ready;
			if (unavailable) return usage(503, unavailable);
			if (stopped) return usage(503, 'The run host has stopped');
			let run: RunLocation;
			let suffix: string | undefined;
			let field: string | undefined;
			try {
				const parts = new URL(request.url).pathname.split('/');
				if (parts[1] !== '.runs' || ![5, 6, 7].includes(parts.length))
					return missing();
				const app = decodeURIComponent(parts[2] ?? '');
				const action = decodeURIComponent(parts[3] ?? '').split('.');
				const id = decodeURIComponent(parts[4] ?? '');
				if (
					!isName(app) ||
					!action.length ||
					!action.every(isName) ||
					!ID.test(id)
				)
					return missing();
				suffix = parts[5];
				if (parts.length === 6 && suffix !== 'events' && suffix !== 'cancel')
					return missing();
				if (parts.length === 7) {
					if (suffix !== 'files') return missing();
					field = decodeURIComponent(parts[6] ?? '');
				}
				run = location(app, action.join(' '), id);
			} catch {
				return missing();
			}
			busy.set(run.key, (busy.get(run.key) ?? 0) + 1);
			try {
				if (
					request.method === 'PUT' &&
					suffix === 'files' &&
					field !== undefined
				)
					return await upload(request, run, field);
				if (request.method === 'POST' && suffix === undefined)
					return await admit(request, run);
				const record = await exclusive(run.key, () => recordOf(run));
				if (!record) return missing();
				if (request.method === 'GET' && suffix === 'events')
					return await events(request, run, record);
				if (request.method === 'GET' && suffix === undefined)
					return Response.json({
						id: run.id,
						app: run.app,
						action: record.action,
						state: record.state,
						lastSeq:
							sequences.get(run.key) ?? (await logOf(run)).at(-1)?.seq ?? 0,
					});
				if (request.method === 'POST' && suffix === 'cancel')
					return await exclusive(run.key, async () => {
						const latest = await recordOf(run);
						if (!latest) return missing();
						if (terminal(latest)) return Response.json({ state: latest.state });
						const owner = claimed.get(run.key);
						if (!owner) return missing();
						if (!owner.cancelRequested) {
							await append(run, { type: 'cancel-requested' });
							owner.cancelRequested = true;
							owner.controller.abort();
						}
						return Response.json({ state: latest.state }, { status: 202 });
					});
				return missing();
			} catch (cause) {
				return Response.json(
					{ error: CliError.Internal({ cause }).error },
					{ status: 500 },
				);
			} finally {
				const count = (busy.get(run.key) ?? 1) - 1;
				if (count) busy.set(run.key, count);
				else busy.delete(run.key);
			}
		},
		stop() {
			stopped = true;
			clearInterval(clock);
			for (const close of [...observers]) close();
		},
	};
}

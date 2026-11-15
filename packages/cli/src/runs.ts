/**
 * Serve-owned runs outlive their observers. One process owns the runtime
 * directory. Cancellation is cooperative; recovery marks a non-terminal
 * record interrupted at startup or on read and never reruns its action.
 * Limits: 15 MiB/file, 1 MiB admission JSON, 256 KiB/yield, 4 MiB/log with
 * 1 KiB reserved for a terminal event, a 512 MiB admission threshold,
 * 32 active runs, and 64 observers. Admission and events stream from SQLite.
 * A finish with a returned answer deletes input bytes. Other outcomes retain
 * them until the 24-hour terminal TTL. Orphan uploads and parts expire in 1 hour.
 */
import {
	chmod,
	type FileHandle,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
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
import {
	LogFull,
	openRunStore,
	type RunStore,
	type RunRecord as StoredRunRecord,
} from './run-store.ts';

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
type LegacyRecord = {
	version: 1;
	id: string;
	app: string;
	action: string;
	inputDigest?: string;
	acceptedAt: string;
	state: 'accepted' | 'running' | 'finished' | 'interrupted';
	endedAt?: string;
	files: Record<string, Pick<FileMeta, 'name' | 'type' | 'size' | 'sha256'>>;
};
type RunRecord = StoredRunRecord;
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
	Response.json(
		{ error: CliError.Usage({ message, next }).error, admitted: false },
		{ status },
	);
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

/** Resolve and create the private runtime directory, refusing app and Epicenter paths before writing. */
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
				timeout: 1_000,
				killSignal: 'SIGKILL',
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

export function createRunHost(
	options: { limits?: { runtimeBytes?: number }; now?: () => number } = {},
) {
	const runtimeLimit = options.limits?.runtimeBytes ?? MAX_RUNTIME_BYTES;
	const now = options.now ?? Date.now;
	let store: RunStore;
	let initialized = false;
	let storeClosed = false;
	let requests = 0;
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

	function closeWhenIdle() {
		if (
			stopped &&
			initialized &&
			!storeClosed &&
			claimed.size === 0 &&
			locks.size === 0 &&
			requests === 0
		) {
			storeClosed = true;
			store.close();
		}
	}

	async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(work);
		locks.set(key, next);
		try {
			return await next;
		} finally {
			if (locks.get(key) === next) locks.delete(key);
			closeWhenIdle();
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

	async function readLegacyEvents(run: RunLocation): Promise<HostEvent[]> {
		const text = await readFile(join(run.dir, 'events.ndjson'), 'utf8').catch(
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return '';
				throw cause;
			},
		);
		const result: HostEvent[] = [];
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (
					object(value) &&
					Number.isSafeInteger(value.seq) &&
					typeof value.at === 'string' &&
					[
						'accepted',
						'started',
						'yielded',
						'cancel-requested',
						'finished',
						'interrupted',
					].includes(String(value.type))
				)
					result.push(value as HostEvent);
			} catch {
				/* A legacy log can have a torn tail. */
			}
		}
		return result;
	}

	/** Publish only after the SQLite transaction commits. */
	async function append(
		run: RunLocation,
		fields: EventFields,
		limit = MAX_LOG_BYTES,
	) {
		const event = store.append(
			run.app,
			run.id,
			{ ...fields, at: new Date(now()).toISOString() },
			{ limit },
		) as HostEvent;
		for (const publish of subscribers.get(run.key) ?? []) publish(event);
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
		if (!terminal(record)) await append(run, { type: 'interrupted', message });
	}

	async function sweep() {
		return exclusive('$sweep', async () => {
			for (const item of store.expire(
				now() - DAY_MS,
				new Set([...claimed.keys(), ...busy.keys()]),
			)) {
				const run = location(item.app, '', item.id);
				if (claimed.has(run.key) || busy.has(run.key)) continue;
				const info = await sizeOf(run.dir).catch(() => ({
					bytes: 0,
					newest: 0,
				}));
				await rm(run.dir, { recursive: true, force: true });
				runtimeBytes = Math.max(0, runtimeBytes - info.bytes);
			}
			for (const run of await runDirs()) {
				if (claimed.has(run.key) || busy.has(run.key)) continue;
				await exclusive(run.key, async () => {
					if (claimed.has(run.key) || busy.has(run.key)) return;
					const legacy = await jsonFile<LegacyRecord>(
						join(run.dir, 'record.json'),
					);
					if (legacy && !store.record(run.app, run.id))
						store.importLegacy(legacy, await readLegacyEvents(run));
					const info = await sizeOf(run.dir);
					if (
						!store.record(run.app, run.id) &&
						!legacy &&
						info.newest < now() - HOUR_MS
					) {
						await rm(run.dir, { recursive: true, force: true });
						runtimeBytes = Math.max(0, runtimeBytes - info.bytes);
						return;
					}
					for (const folder of [run.dir, join(run.dir, 'files')]) {
						if (await exists(folder))
							for (const name of await readdir(folder)) {
								if (
									name.includes('.part-') &&
									(await stat(join(folder, name))).mtimeMs < now() - HOUR_MS
								)
									await deleteFile(join(folder, name));
							}
					}
				});
			}
			store.compact();
		});
	}

	const ready = (async () => {
		try {
			dir = await resolveRuntimeDir();
			await makeDir(join(dir, 'runs'));
			runtimeBytes = (await sizeOf(join(dir, 'runs'))).bytes;
			store = openRunStore({ path: join(dir, 'runs.sqlite') });
			for (const run of await runDirs()) {
				const record = await jsonFile<LegacyRecord>(
					join(run.dir, 'record.json'),
				);
				if (record) store.importLegacy(record, await readLegacyEvents(run));
			}
			for (const record of store.nonTerminal())
				await interrupt(location(record.app, record.action, record.id), record);
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
			initialized = true;
			closeWhenIdle();
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
			if (
				runtimeBytes +
					store.sizes() +
					reservedBytes +
					length +
					claimed.size * MAX_LOG_BYTES >
				runtimeLimit
			)
				await sweep();
			if (
				runtimeBytes +
					store.sizes() +
					reservedBytes +
					length +
					claimed.size * MAX_LOG_BYTES >
				runtimeLimit
			)
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
				if (store.record(run.app, run.id))
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
					if (!(cause instanceof LogFull)) throw cause;
					// An oversized return value still leaves a bounded terminal envelope.
					answer = {
						error: CliError.Usage({
							message: 'The run answer could not fit in its 4 MiB event log',
						}).error,
					};
					await append(run, { type: 'finished', answer });
				}
				if ('returned' in answer) await deleteBins(run);
			});
		} catch (cause) {
			try {
				await exclusive(run.key, async () => {
					// A finished log is already definitive, even if its record update failed.
					const persisted = store.record(run.app, run.id);
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
			closeWhenIdle();
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
					admitted: false,
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
		// A JSON digest could confirm guesses about a private input, which is otherwise
		// never written here; uploaded file bytes and their hashes follow the ordinary retention rules.
		const inputDigest = action.privateInput
			? undefined
			: hash(
					JSON.stringify(stable({ action: run.action, input: checked.input })),
				);
		return exclusive(run.key, async () => {
			let existing = store.record(run.app, run.id);
			if (existing) {
				if (!terminal(existing) && !claimed.has(run.key)) {
					await interrupt(run, existing);
					existing = store.record(run.app, run.id)!;
				}
				if (
					existing.action !== run.action ||
					(!action.privateInput && existing.inputDigest !== inputDigest)
				)
					return usage(
						409,
						'This run id was already admitted with different input or action',
					);
				// A join was already admitted; its observer limit response has no refusal marker.
				return events(request, run, existing, true, 0);
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
			if (
				runtimeBytes +
					store.sizes() +
					reservedBytes +
					(claimed.size + 1) * MAX_LOG_BYTES >
				runtimeLimit
			)
				await sweep();
			// No await between the capacity checks, commit, and claiming the run.
			if (claimed.size >= 32)
				return usage(429, 'Thirty-two runs are already active on this host');
			if (
				runtimeBytes +
					store.sizes() +
					reservedBytes +
					(claimed.size + 1) * MAX_LOG_BYTES >
				runtimeLimit
			)
				return usage(507, 'The run runtime directory is full');
			const admitted = store.admit({
				app: run.app,
				id: run.id,
				action: run.action,
				inputDigest,
				files,
				at: new Date(now()).toISOString(),
			});
			if (!admitted.created)
				throw new Error('Run admission changed unexpectedly');
			const controller = new AbortController();
			claimed.set(run.key, { controller, cancelRequested: false });
			void execute(
				run,
				admitted.created,
				located,
				action,
				decoded,
				controller,
			).catch((cause) => writeErr(`Run executor failed: ${String(cause)}`));
			return events(request, run, admitted.created, false, 0);
		});
	}

	async function recordOf(run: RunLocation) {
		let record = store.record(run.app, run.id);
		if (!record || record.action !== run.action) return undefined;
		if (!terminal(record) && !claimed.has(run.key)) {
			await interrupt(run, record);
			record = store.record(run.app, run.id)!;
		}
		return record;
	}

	async function events(
		request: Request,
		run: RunLocation,
		record: RunRecord,
		counted = true,
		initialAfter?: number,
	): Promise<Response> {
		if (stopped)
			return Response.json(
				{
					error: CliError.Usage({ message: 'The run host has stopped' }).error,
				},
				{ status: 503 },
			);
		const after = String(
			initialAfter ?? new URL(request.url).searchParams.get('after') ?? '0',
		);
		if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
			return usage(400, 'after must be a non-negative integer');
		if (counted && streams >= 64)
			return Response.json(
				{
					...(initialAfter === 0 ? { admitted: true } : {}),
					error: CliError.Usage({
						message: 'Too many run observers are connected',
					}).error,
				},
				{ status: 429 },
			);
		if (counted) streams++;
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
			if (counted) streams--;
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
			if (event.seq > cursor || (isTerminal(event) && terminal(record))) {
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
			const replay = store.events(run.app, run.id, Number(after));
			if (terminal(record) && replay.length === 0)
				replay.push(
					...store.events(run.app, run.id, Math.max(0, record.lastSeq - 1)),
				);
			for (const event of replay) send(event as HostEvent);
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
			requests++;
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
						lastSeq: record.lastSeq,
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
				requests--;
				closeWhenIdle();
			}
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(clock);
			for (const close of [...observers]) close();
			// Active executors retain the store until the last one exits.
			closeWhenIdle();
		},
	};
}

/**
 * A store over a directory the program serving this page owns on this
 * computer, reached through that program (ADR-0784): the page asks, the
 * program's directory store answers (`handler.ts`, over `node-store.ts`),
 * and every version is that store's own, passed through unread. See
 * `wire.ts` for the requests.
 *
 * A watch answers once the program says it is watching the directory, and
 * from then forwards what the program hears. A directory has no commits, so
 * nothing replays what a dropped watch missed: a dropped watch is heard as
 * `'all'`, the store asks again every `retryMs`, and when the program
 * answers it is heard as `'all'` once more, so a reader lists again and
 * reads what differs.
 */
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	Changed,
	FileRead,
	Listed,
	Store,
	Unavailable,
	Version,
} from '../device/store.js';
import {
	fromBase64,
	isRecord,
	isStrings,
	toBase64,
	type Verb,
} from './wire.js';

/** How long a dropped watch waits before it asks the program again. */
const RETRY_MS = 1000;

/** What one request answered: the JSON body, or why it has none the wire expects. */
type Answer =
	| { kind: 'answered'; body: Record<string, unknown>; response: Response }
	/** The program answered, and the store could not be reached. */
	| { kind: 'unavailable'; reason: string }
	/** Nothing there speaks the wire: not the program, or not its directory. */
	| { kind: 'not served'; status: number }
	/** The request did not reach the program. */
	| { kind: 'unreachable'; cause: unknown };

/** Ask `verb` of the program at `base`. */
async function ask(
	base: string,
	verb: Verb,
	body: unknown,
	signal?: AbortSignal,
): Promise<Answer> {
	let response: Response;
	try {
		response = await fetch(`${base}/${verb}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
	} catch (cause) {
		return { kind: 'unreachable', cause };
	}
	const json = response.headers
		.get('content-type')
		?.startsWith('application/json');
	if (verb === 'watch' && response.ok)
		return { kind: 'answered', body: {}, response };
	const answer: unknown = json ? await response.json().catch(() => null) : null;
	if (response.status === 503 && isRecord(answer))
		return {
			kind: 'unavailable',
			reason:
				typeof answer.unavailable === 'string'
					? answer.unavailable
					: 'the program could not reach its directory',
		};
	if (!response.ok || !isRecord(answer))
		return { kind: 'not served', status: response.status };
	return { kind: 'answered', body: answer, response };
}

/** An answer other than a body, as the store's failure. */
function failure(base: string, answer: Answer): Result<never, Unavailable> {
	switch (answer.kind) {
		case 'unreachable':
			return ClientError.Unavailable({ cause: answer.cause });
		case 'unavailable':
			return ClientError.Unavailable({ cause: answer.reason });
		case 'not served':
			return ClientError.Unavailable({
				cause: `nothing at ${base} keeps this app's files (it answered ${answer.status})`,
			});
		case 'answered':
			throw new Error('an answer with a body is no failure');
	}
}

/**
 * Whether the program at `base` answers for a directory: `'served'`,
 * `'not served'` when something else answered (the page did not come from
 * its program), or `Unavailable` when the program could not be reached.
 */
export async function probe(
	base: string,
): Promise<Result<'served' | 'not served', Unavailable>> {
	const answer = await ask(base, 'list', { under: [] });
	if (answer.kind === 'answered') return Ok('served');
	if (answer.kind === 'not served') return Ok('not served');
	return failure(base, answer);
}

/** One open watch of the program's directory: its lines after `{ listening }`, and its stop. */
type Watching = { lines: AsyncGenerator<string>; abort: () => void };

/** The lines of a stream, without their line ends. */
async function* linesOf(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let end = buffer.indexOf('\n');
			while (end !== -1) {
				yield buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf('\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** The store of the directory the program at `base` (`/folder`, or a full URL) serves. */
export function servedStore(
	base: string,
	{ retryMs = RETRY_MS }: { retryMs?: number } = {},
): Store {
	let closed = false;
	const watches = new Set<() => void>();
	const stopped = () =>
		ClientError.Unavailable({ cause: 'the store was closed' });

	/** The body `verb` answered, or the store's failure. */
	async function call(
		verb: Exclude<Verb, 'watch'>,
		body: unknown,
	): Promise<Result<Record<string, unknown>, Unavailable>> {
		if (closed) return stopped();
		const answer = await ask(base, verb, body);
		if (answer.kind !== 'answered') return failure(base, answer);
		return Ok(answer.body);
	}

	/** A body that is not what `verb` answers. */
	const misread = (verb: Verb) =>
		ClientError.Unavailable({
			cause: `the program's answer to ${verb} is not one this page reads`,
		});

	/** Open one watch: answers once the program says it is listening. */
	async function connect(): Promise<Result<Watching, Unavailable>> {
		const controller = new AbortController();
		const answer = await ask(base, 'watch', {}, controller.signal);
		if (answer.kind !== 'answered') return failure(base, answer);
		const { body } = answer.response;
		if (!body) return misread('watch');
		const lines = linesOf(body);
		const abort = () => controller.abort();
		try {
			// Not `for await`, which would end `lines` on leaving the loop.
			for (;;) {
				const next = await lines.next();
				if (next.done) break;
				if (next.value === '') continue;
				const message: unknown = JSON.parse(next.value);
				if (isRecord(message) && message.listening === true)
					return Ok({ lines, abort });
				break;
			}
		} catch (cause) {
			abort();
			return ClientError.Unavailable({ cause });
		}
		abort();
		return misread('watch');
	}

	return {
		async list(under) {
			const answered = await call('list', { under });
			if (answered.error !== null) return answered;
			const { files } = answered.data;
			if (!Array.isArray(files)) return misread('list');
			return Ok(files as Listed[]);
		},
		async read(paths): Promise<Result<FileRead[], Unavailable>> {
			if (paths.length === 0) return Ok([]);
			const answered = await call('read', { paths });
			if (answered.error !== null) return answered;
			const { files } = answered.data;
			if (!Array.isArray(files)) return misread('read');
			const read: FileRead[] = [];
			for (const file of files) {
				if (!isRecord(file) || typeof file.path !== 'string')
					return misread('read');
				if (file.gone === true) {
					read.push({ path: file.path, gone: true });
					continue;
				}
				if (typeof file.bytes !== 'string' || typeof file.version !== 'string')
					return misread('read');
				read.push({
					path: file.path,
					bytes: fromBase64(file.bytes),
					version: file.version as Version,
				});
			}
			return Ok(read);
		},
		async write(path, bytes, over) {
			const answered = await call('write', {
				path,
				bytes: bytes === null ? null : toBase64(bytes),
				over,
			});
			if (answered.error !== null) return answered;
			const { landed } = answered.data;
			if (landed !== null && typeof landed !== 'string')
				return misread('write');
			return Ok(landed as Version | null | 'stale');
		},
		async watch(changed: Changed) {
			if (closed) return stopped();
			const first = await connect();
			if (first.error !== null) return first;
			let current: Watching | undefined = first.data;
			let done = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			async function follow(watching: Watching) {
				try {
					for await (const text of watching.lines) {
						if (done) return;
						if (text === '') continue;
						const message: unknown = JSON.parse(text);
						if (!isRecord(message)) continue;
						const paths = message.changed;
						if (paths === 'all' || isStrings(paths)) changed(paths);
					}
				} catch {
					// A dropped connection, or a line this page cannot read.
				}
				if (done) return;
				watching.abort();
				current = undefined;
				changed('all');
				timer = setTimeout(reconnect, retryMs);
			}

			async function reconnect() {
				if (done) return;
				const again = await connect();
				if (done) {
					if (again.error === null) again.data.abort();
					return;
				}
				if (again.error !== null) {
					timer = setTimeout(reconnect, retryMs);
					return;
				}
				current = again.data;
				changed('all');
				void follow(again.data);
			}

			function stop() {
				if (done) return;
				done = true;
				clearTimeout(timer);
				current?.abort();
				watches.delete(stop);
			}
			watches.add(stop);
			void follow(first.data);
			return Ok(stop);
		},
		close() {
			closed = true;
			for (const stop of [...watches]) stop();
		},
	};
}

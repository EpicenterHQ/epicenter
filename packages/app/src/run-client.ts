/**
 * Follow serve-owned runs across page closure and reconnection. The browser
 * journals an id before sending anything and observes ambiguous admission by
 * that id; it never resends admission or assumes which effects persisted.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ActionError, isActionError } from './errors.ts';

export type PendingRun = {
	id: string;
	app: string;
	action: string;
	startedAt: string;
	files: { field: string; name: string; type: string; size: number }[];
};

export type RunEvent<TYield, TOut> =
	| { type: 'uploading'; field: string; size: number }
	| { type: 'uploaded'; field: string }
	| { type: 'failed'; error: ActionError }
	| { type: 'accepted'; seq: number; at: string }
	| { type: 'started'; seq: number; at: string }
	| { type: 'yielded'; seq: number; at: string; value: TYield }
	| { type: 'cancel-requested'; seq: number; at: string }
	| {
			type: 'finished';
			seq: number;
			at: string;
			result: Result<TOut, ActionError>;
	  }
	| { type: 'interrupted'; seq: number; at: string; error: ActionError }
	| { type: 'unknown'; error: ActionError }
	| { type: 'disconnected'; error: ActionError };

export type Run<TYield, TOut> = {
	readonly id: string;
	readonly app: string;
	readonly action: string;
	events(options?: {
		after?: number;
		signal?: AbortSignal;
	}): AsyncIterable<RunEvent<TYield, TOut>>;
	/** Wait for a terminal answer. Aborting stops observation, not the host run. */
	result(options?: {
		signal?: AbortSignal;
		onYield?: (value: TYield) => unknown;
	}): Promise<Result<TOut, ActionError>>;
	isRemembered(): boolean;
	cancel(): Promise<Result<null, ActionError>>;
};

// This persisted key predates the module rename; keep existing pending runs visible.
const JOURNAL_KEY = 'epicenter.runs.prototype.v1';
const REQUEST_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPendingRun(value: unknown): value is PendingRun {
	return (
		isObject(value) &&
		typeof value.id === 'string' &&
		typeof value.app === 'string' &&
		typeof value.action === 'string' &&
		typeof value.startedAt === 'string' &&
		Number.isFinite(Date.parse(value.startedAt)) &&
		Array.isArray(value.files) &&
		value.files.every(
			(file) =>
				isObject(file) &&
				typeof file.field === 'string' &&
				typeof file.name === 'string' &&
				typeof file.type === 'string' &&
				typeof file.size === 'number' &&
				Number.isFinite(file.size) &&
				file.size >= 0,
		)
	);
}

const PREFIX = 'epicenter.run:';
const memory = new Map<string, PendingRun>();
function storage(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}
function save(entry: PendingRun) {
	try {
		const target = storage();
		if (!target) throw new Error('Storage unavailable');
		target.setItem(PREFIX + entry.id, JSON.stringify(entry));
		memory.delete(entry.id);
	} catch {
		if (memory.size < 256 || memory.has(entry.id)) memory.set(entry.id, entry);
	}
}
function removePending(id: string) {
	memory.delete(id);
	try {
		storage()?.removeItem(PREFIX + id);
	} catch {
		/* Storage is unavailable. */
	}
}
function remembered(id: string) {
	try {
		return storage()?.getItem(PREFIX + id) != null;
	} catch {
		return false;
	}
}
export function pendingRuns({ app }: { app?: string } = {}): PendingRun[] {
	const entries = new Map(memory);
	try {
		const target = storage();
		if (target) {
			const old = target.getItem(JOURNAL_KEY);
			if (old !== null) {
				let imported = true;
				try {
					const values: unknown = JSON.parse(old);
					if (Array.isArray(values))
						for (const entry of values) {
							if (!isPendingRun(entry)) continue;
							try {
								if (target.getItem(PREFIX + entry.id) === null)
									target.setItem(PREFIX + entry.id, JSON.stringify(entry));
							} catch {
								imported = false;
								if (memory.size < 256) memory.set(entry.id, entry);
							}
						}
				} catch {
					/* malformed legacy journal */
				}
				if (imported) target.removeItem(JOURNAL_KEY);
			}
			const keys = Array.from({ length: target.length }, (_, i) =>
				target.key(i),
			).filter((key): key is string => key?.startsWith(PREFIX) ?? false);
			for (const key of keys) {
				try {
					const value: unknown = JSON.parse(target.getItem(key) ?? 'null');
					if (isPendingRun(value) && key === PREFIX + value.id)
						entries.set(value.id, value);
				} catch {
					/* Ignore one malformed receipt. */
				}
			}
		}
	} catch {
		/* Memory receipts remain available. */
	}
	for (const entry of memory.values()) entries.set(entry.id, entry);
	for (const entry of entries.values())
		if (Date.parse(entry.startedAt) < Date.now() - 7 * DAY_MS) {
			removePending(entry.id);
			entries.delete(entry.id);
		}
	return [...entries.values()].filter(
		(entry) => app === undefined || entry.app === app,
	);
}

/** Wait for a notification or abort; the subscription owns cleanup. */
function notified(
	subscribe: (wake: () => void) => () => void,
	signal?: AbortSignal,
) {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const wake = () => {
			unsubscribe();
			signal?.removeEventListener('abort', wake);
			resolve();
		};
		const unsubscribe = subscribe(wake);
		signal?.addEventListener('abort', wake, { once: true });
	});
}

function pause(ms: number, signal?: AbortSignal) {
	return notified((wake) => {
		const timer = setTimeout(wake, ms);
		return () => clearTimeout(timer);
	}, signal);
}

function isTaggedError(
	value: unknown,
): value is { name: string; message: string } & Record<string, unknown> {
	return (
		isObject(value) &&
		typeof value.name === 'string' &&
		typeof value.message === 'string'
	);
}

/** Validate serve's terminal answer; the action owns the shape of its returned value. */
function answered(
	answer: unknown,
	run: { app: string; action: string; id: string },
): Result<unknown, ActionError> {
	const invalid = () =>
		ActionError.Unreachable({
			message: 'Epicenter sent an invalid answer',
			run,
		});
	if (!isObject(answer)) return invalid();
	if (
		['returned', 'threw', 'error'].filter((key) => Object.hasOwn(answer, key))
			.length !== 1
	)
		return invalid();
	if ('returned' in answer) return Ok(answer.returned);
	if ('threw' in answer) {
		const failure = answer.threw;
		if (!isObject(failure) || typeof failure.message !== 'string')
			return invalid();
		const { thrown } = failure;
		if (thrown !== undefined && !isTaggedError(thrown)) return invalid();
		return isActionError(thrown)
			? Err(thrown)
			: ActionError.Threw({ message: failure.message, thrown });
	}
	const failure = answer.error;
	if (
		!isObject(failure) ||
		typeof failure.message !== 'string' ||
		(failure.next !== undefined && typeof failure.next !== 'string')
	)
		return invalid();
	return ActionError.Refused({ message: failure.message, next: failure.next });
}

type Identity = { app: string; action: string; id: string };
async function responseError(response: Response): Promise<ActionError> {
	try {
		const body: unknown = await response.json();
		if (
			isObject(body) &&
			isObject(body.error) &&
			typeof body.error.message === 'string'
		)
			return ActionError.Refused({
				message: body.error.message,
				next: typeof body.error.next === 'string' ? body.error.next : undefined,
			}).error;
	} catch {
		/* The status still identifies a refusal. */
	}
	return ActionError.Refused({
		message: `Epicenter answered ${response.status} ${response.statusText}`,
	}).error;
}
function hostEvent(value: unknown, run: Identity): RunEvent<unknown, unknown> {
	if (
		!isObject(value) ||
		!Number.isSafeInteger(value.seq) ||
		(value.seq as number) <= 0 ||
		typeof value.at !== 'string'
	)
		throw new Error('Invalid event');
	const seq = value.seq as number,
		at = value.at;
	switch (value.type) {
		case 'accepted':
		case 'started':
		case 'cancel-requested':
			return { type: value.type, seq, at };
		case 'yielded':
			if (!Object.hasOwn(value, 'value')) throw new Error('Invalid event');
			return { type: 'yielded', seq, at, value: value.value };
		case 'finished':
			if (!Object.hasOwn(value, 'answer')) throw new Error('Invalid event');
			return { type: 'finished', seq, at, result: answered(value.answer, run) };
		case 'interrupted':
			if (typeof value.message !== 'string') throw new Error('Invalid event');
			return {
				type: 'interrupted',
				seq,
				at,
				error: ActionError.Unreachable({ message: value.message, run }).error,
			};
		default:
			throw new Error('Invalid event');
	}
}
type Sequenced = Extract<RunEvent<unknown, unknown>, { seq: number }>;
type Notice = Extract<
	RunEvent<unknown, unknown>,
	{ type: 'unknown' | 'disconnected' }
>;
type Observer = { cursor: number; notice?: Notice };

/** Create a run ID in both secure and plain HTTP contexts. */
export function runId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRun({
	base,
	app,
	action,
	id,
	input,
	remember,
}: {
	base: string;
	app: string;
	action: string;
	id: string;
	input?: Record<string, unknown>;
	remember: boolean;
}): Run<unknown, unknown> {
	const run = { app, action, id };
	const url = `${base}.runs/${encodeURIComponent(app)}/${action}/${encodeURIComponent(id)}`;
	const local: RunEvent<unknown, unknown>[] = [];
	const waiters = new Set<() => void>();
	const observers = new Set<Observer>();
	const uploads = new AbortController();
	let settled = input === undefined,
		postSent = input === undefined,
		failed = false;
	let terminal: Result<unknown, ActionError> | undefined;
	let terminalSeq = 0,
		floor = 0;
	let buffer: Sequenced[] = [];
	let source: Response | undefined;
	let sourceController: AbortController | undefined;
	let pumpController: AbortController | undefined;
	let pumping = false;
	let admission: Promise<void> = Promise.resolve();
	const notify = () => {
		for (const wake of [...waiters]) wake();
	};
	const subscribe = (wake: () => void) => {
		waiters.add(wake);
		return () => {
			waiters.delete(wake);
		};
	};
	const unreachable = (message: string) =>
		ActionError.Unreachable({ message, run }).error;
	const fail = (error: ActionError) => {
		if (failed) return;
		failed = true;
		terminal = Err(error);
		local.push({ type: 'failed', error });
		if (remember) removePending(id);
		notify();
	};
	const notice = (event: Notice) => {
		for (const observer of observers) observer.notice = event;
		notify();
	};
	const abortPump = () => {
		pumpController?.abort();
		sourceController?.abort();
	};
	if (input !== undefined) {
		const body = { ...input };
		const files = Object.entries(body).filter(
			(entry): entry is [string, Blob] => entry[1] instanceof Blob,
		);
		const fileName = (blob: Blob) =>
			typeof File !== 'undefined' && blob instanceof File ? blob.name : 'blob';
		if (remember)
			save({
				id,
				app,
				action,
				startedAt: new Date().toISOString(),
				files: files.map(([field, blob]) => ({
					field,
					name: fileName(blob),
					type: blob.type,
					size: blob.size,
				})),
			});
		admission = Promise.resolve().then(async () => {
			try {
				for (const [field, blob] of files) {
					if (failed) return;
					local.push({ type: 'uploading', field, size: blob.size });
					notify();
					const response = await fetch(
						`${url}/files/${encodeURIComponent(field)}`,
						{
							method: 'PUT',
							body: blob,
							signal: uploads.signal,
							headers: {
								'content-type': blob.type || 'application/octet-stream',
								'x-epicenter-file-name': encodeURIComponent(fileName(blob)),
							},
						},
					);
					if (failed) return;
					if (response.status !== 200) {
						fail(await responseError(response));
						return;
					}
					const receipt: unknown = await response.json();
					if (!isObject(receipt) || typeof receipt.reference !== 'string') {
						fail(unreachable('Epicenter sent an invalid file reference'));
						return;
					}
					body[field] = receipt.reference;
					local.push({ type: 'uploaded', field });
					notify();
				}
				if (failed) return;
				const json = JSON.stringify(body);
				postSent = true;
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
				try {
					const response = await fetch(url, {
						method: 'POST',
						redirect: 'manual',
						headers: { 'content-type': 'application/json' },
						body: json,
						signal: controller.signal,
					});
					clearTimeout(timer);
					if (response.status === 200 && response.body) {
						source = response;
						sourceController = controller;
					} else {
						let marker: unknown;
						try {
							marker = await response.clone().json();
						} catch {
							/* No admission marker. */
						}
						const admitted = isObject(marker) ? marker.admitted : undefined;
						if (
							admitted === false ||
							(admitted !== true &&
								response.status >= 400 &&
								response.status < 500)
						)
							fail(await responseError(response));
						void response.body?.cancel().catch(() => {});
					}
				} catch {
					/* Admission is uncertain; observe the id. */
				} finally {
					clearTimeout(timer);
				}
			} catch (cause) {
				if (!failed && !postSent)
					fail(
						unreachable(
							`Could not send the run to Epicenter: ${String(cause)}`,
						),
					);
			} finally {
				settled = true;
				if (!observers.size && source) {
					void source.body?.cancel().catch(() => {});
					source = undefined;
					sourceController = undefined;
				}
				notify();
				startPump();
			}
		});
	}
	const needsReplay = () =>
		!terminal ||
		(floor < terminalSeq && !buffer.some((event) => event.seq === terminalSeq));
	function startPump() {
		if (pumping || !settled || failed || !observers.size || !needsReplay())
			return;
		pumping = true;
		const controller = new AbortController();
		pumpController = controller;
		void pump(controller.signal).finally(() => {
			pumping = false;
			if (pumpController === controller) pumpController = undefined;
			if (
				observers.size &&
				needsReplay() &&
				[...observers].some((o) => !o.notice)
			)
				startPump();
		});
	}
	async function pump(signal: AbortSignal) {
		let failures = 0;
		while (!signal.aborted && observers.size && needsReplay()) {
			let delivered = false,
				openedAt = 0,
				normal = false;
			try {
				let response: Response;
				if (source) {
					response = source;
					source = undefined;
				} else
					response = await fetch(
						`${url}/events?after=${buffer.at(-1)?.seq ?? floor}`,
						{ signal },
					);
				if (response.status === 404) {
					notice({
						type: 'unknown',
						error: unreachable(
							`Epicenter has no run ${id} for ${app} ${action}: it was never accepted or has expired. It was not run again.`,
						),
					});
					return;
				}
				if (!response.ok || !response.body)
					throw new Error('Could not read events');
				openedAt = Date.now();
				const reader = response.body.getReader();
				const stop = () => {
					void reader.cancel().catch(() => {});
				};
				signal.addEventListener('abort', stop, { once: true });
				try {
					const decoder = new TextDecoder();
					let text = '';
					for (;;) {
						const part = await reader.read();
						if (signal.aborted) return;
						text += decoder.decode(part.value, { stream: !part.done });
						let end = text.indexOf('\n');
						while (end >= 0 || (part.done && text.length)) {
							const line = end >= 0 ? text.slice(0, end) : text;
							text = end >= 0 ? text.slice(end + 1) : '';
							if (line.trim()) {
								let event: RunEvent<unknown, unknown>;
								try {
									event = hostEvent(JSON.parse(line), run);
								} catch {
									notice({
										type: 'disconnected',
										error: unreachable('Epicenter sent an invalid run event'),
									});
									return;
								}
								if (!('seq' in event)) throw new Error('Invalid event');
								const last = buffer.at(-1)?.seq ?? floor;
								if (event.seq > last) {
									if (event.seq !== last + 1)
										throw new Error('Gap in event stream');
									buffer.push(event);
									delivered = true;
								}
								if (event.type === 'finished' || event.type === 'interrupted') {
									terminal =
										event.type === 'finished' ? event.result : Err(event.error);
									terminalSeq = event.seq;
									if (remember || input === undefined) removePending(id);
									notify();
									return;
								}
								notify();
							}
							end = text.indexOf('\n');
						}
						if (part.done) {
							normal = true;
							break;
						}
					}
				} finally {
					signal.removeEventListener('abort', stop);
					void reader.cancel().catch(() => {});
					reader.releaseLock();
					sourceController = undefined;
				}
			} catch {
				if (signal.aborted) return;
			}
			if (delivered || (normal && Date.now() - openedAt >= 5000)) {
				failures = 0;
				continue;
			}
			if (++failures >= 6) {
				notice({
					type: 'disconnected',
					error: unreachable(
						'Lost the connection to Epicenter; the run may still be running. Attach again to follow it.',
					),
				});
				return;
			}
			await pause(Math.min(500 * 2 ** failures, 10000), signal);
		}
	}
	async function* events({
		after,
		signal,
	}: {
		after?: number;
		signal?: AbortSignal;
	} = {}): AsyncGenerator<RunEvent<unknown, unknown>> {
		if (signal?.aborted) return;
		const observer: Observer = { cursor: after ?? 0 };
		if (!buffer.length && !observers.size) floor = observer.cursor;
		else if (observer.cursor < floor) {
			floor = observer.cursor;
			buffer = [];
			abortPump();
		}
		observers.add(observer);
		startPump();
		try {
			let localCursor = 0;
			while (!signal?.aborted) {
				if (after === undefined)
					while (localCursor < local.length) {
						if (signal?.aborted) return;
						const item = local[localCursor++];
						if (item) yield item;
					}
				if (failed || signal?.aborted) return;
				if (!settled) {
					await notified(subscribe, signal);
					continue;
				}
				startPump();
				for (const event of buffer) {
					if (signal?.aborted) return;
					if (event.seq <= observer.cursor) continue;
					observer.cursor = event.seq;
					yield event;
					if (event.type === 'finished' || event.type === 'interrupted') return;
				}
				if (observer.notice) {
					yield observer.notice;
					return;
				}
				if (terminal && terminalSeq <= observer.cursor) return;
				await notified(subscribe, signal);
			}
		} finally {
			observers.delete(observer);
			if (!observers.size) abortPump();
		}
	}
	return {
		id,
		app,
		action,
		events,
		isRemembered: () => remembered(id),
		async result({ signal, onYield } = {}) {
			if (terminal && !onYield) return terminal;
			for await (const event of events({ signal })) {
				if (event.type === 'yielded') await onYield?.(event.value);
				if (event.type === 'finished') return event.result;
				if (
					event.type === 'failed' ||
					event.type === 'interrupted' ||
					event.type === 'unknown' ||
					event.type === 'disconnected'
				)
					return Err(event.error);
			}
			return (
				(signal?.aborted ? undefined : terminal) ??
				ActionError.Stopped({
					message:
						'Stopped waiting for the run; this did not request cancellation',
					run,
				})
			);
		},
		async cancel() {
			if (!postSent) {
				uploads.abort();
				fail(
					ActionError.Stopped({
						message:
							'Cancelled before Epicenter accepted the run; it was not run',
						run,
					}).error,
				);
				return Ok(null);
			}
			await admission;
			if (failed) return Ok(null);
			const controller = new AbortController(),
				timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await fetch(`${url}/cancel`, {
					method: 'POST',
					signal: controller.signal,
				});
				if (response.status === 200 || response.status === 202) return Ok(null);
				if (response.status === 404)
					return ActionError.Unreachable({
						message: `Epicenter has no run ${id} to cancel; cancellation is unconfirmed`,
						run,
					});
				return ActionError.Unreachable({
					message: `Epicenter answered ${response.status} ${response.statusText}`,
					run,
				});
			} catch (cause) {
				return ActionError.Unreachable({
					message: `Could not cancel the run on Epicenter: ${String(cause)}`,
					run,
				});
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

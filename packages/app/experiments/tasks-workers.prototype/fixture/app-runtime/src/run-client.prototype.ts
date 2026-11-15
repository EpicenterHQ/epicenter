/**
 * PROTOTYPE: A throwaway browser slice to learn host-owned runs.
 * See /packages/cli/prototype/runs-demo/NOTES.md for the experiment.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ActionError } from './errors.js';

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
	result(options?: {
		signal?: AbortSignal;
	}): Promise<Result<TOut, ActionError>>;
	cancel(): Promise<Result<null, ActionError>>;
};

const JOURNAL_KEY = 'epicenter.runs.prototype.v1';
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

export function pendingRuns({ app }: { app?: string } = {}): PendingRun[] {
	try {
		const entries: unknown = JSON.parse(
			globalThis.localStorage.getItem(JOURNAL_KEY) ?? '[]',
		);
		if (!Array.isArray(entries) || !entries.every(isPendingRun)) return [];
		return app === undefined
			? entries
			: entries.filter((entry) => entry.app === app);
	} catch {
		return [];
	}
}

function writeJournal(entries: PendingRun[]) {
	globalThis.localStorage.setItem(
		JOURNAL_KEY,
		JSON.stringify(
			entries.filter(
				(entry) => Date.parse(entry.startedAt) >= Date.now() - DAY_MS,
			),
		),
	);
}

function removePending(id: string) {
	try {
		writeJournal(pendingRuns().filter((entry) => entry.id !== id));
	} catch {
		// The browser may revoke storage access after admission. Keep observing.
	}
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

async function responseError(response: Response): Promise<ActionError> {
	if (response.status >= 400 && response.status < 500) {
		try {
			const body: unknown = await response.json();
			if (
				isObject(body) &&
				isObject(body.error) &&
				typeof body.error.message === 'string'
			)
				return ActionError.Refused({
					message: body.error.message,
					next:
						typeof body.error.next === 'string' ? body.error.next : undefined,
				}).error;
		} catch {
			// A refusal with no JSON body still definitively declined admission.
		}
		return ActionError.Refused({
			message: `Epicenter answered ${response.status} ${response.statusText}`,
		}).error;
	}
	return ActionError.Unreachable({
		message: `Epicenter answered ${response.status} ${response.statusText}`,
	}).error;
}

function hostEvent(
	value: unknown,
	answered: (answer: unknown) => Result<unknown, ActionError>,
): RunEvent<unknown, unknown> {
	if (
		!isObject(value) ||
		!Number.isSafeInteger(value.seq) ||
		(value.seq as number) <= 0 ||
		typeof value.at !== 'string'
	)
		throw new Error('Invalid run event');
	const seq = value.seq as number;
	const at = value.at;
	switch (value.type) {
		case 'accepted':
		case 'started':
		case 'cancel-requested':
			return { type: value.type, seq, at };
		case 'yielded':
			if (!Object.hasOwn(value, 'value')) throw new Error('Invalid run event');
			return { type: 'yielded', seq, at, value: value.value };
		case 'finished':
			if (!Object.hasOwn(value, 'answer')) throw new Error('Invalid run event');
			return { type: 'finished', seq, at, result: answered(value.answer) };
		case 'interrupted':
			if (typeof value.message !== 'string')
				throw new Error('Invalid run event');
			return {
				type: 'interrupted',
				seq,
				at,
				error: ActionError.Unreachable({ message: value.message }).error,
			};
		default:
			throw new Error('Invalid run event');
	}
}

export function createRunMethods({
	base,
	app,
	action,
	answered,
}: {
	base: string;
	app: string;
	action: string;
	answered: (answer: unknown) => Result<unknown, ActionError>;
}) {
	function createRun(
		id: string,
		input?: Record<string, unknown>,
	): Run<unknown, unknown> {
		const url = `${base}.runs/${encodeURIComponent(app)}/${action}/${encodeURIComponent(id)}`;
		const local: RunEvent<unknown, unknown>[] = [];
		const waiters = new Set<() => void>();
		const uploads = new AbortController();
		let settled = input === undefined;
		let postSent = input === undefined;
		let failed = false;
		let terminal: Result<unknown, ActionError> | undefined;
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
		const fail = (error: ActionError, remove: boolean) => {
			if (failed) return;
			failed = true;
			terminal = Err(error);
			local.push({ type: 'failed', error });
			if (remove) removePending(id);
			notify();
		};
		const observe = (event: RunEvent<unknown, unknown>) => {
			if (event.type === 'finished') terminal = event.result;
			else if (event.type === 'interrupted' || event.type === 'unknown')
				terminal = Err(event.error);
			else return false;
			removePending(id);
			return true;
		};

		if (input !== undefined) {
			// Snapshot top-level values before returning control to the caller.
			const body = { ...input };
			const files = Object.entries(body).filter(
				(entry): entry is [string, Blob] => entry[1] instanceof Blob,
			);
			const fileName = (blob: Blob) =>
				typeof File !== 'undefined' && blob instanceof File
					? blob.name
					: 'blob';
			try {
				writeJournal([
					...pendingRuns(),
					{
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
					},
				]);
			} catch {
				fail(
					ActionError.Refused({
						message:
							'Could not record the run in this browser, so it was not sent',
					}).error,
					true,
				);
				settled = true;
			}
			if (!failed)
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
								fail(await responseError(response), true);
								return;
							}
							const receipt: unknown = await response.json();
							if (!isObject(receipt) || typeof receipt.reference !== 'string') {
								fail(
									ActionError.Unreachable({
										message: 'Epicenter sent an invalid file reference',
									}).error,
									true,
								);
								return;
							}
							if (failed) return;
							body[field] = receipt.reference;
							local.push({ type: 'uploaded', field });
							notify();
						}
						if (failed) return;
						const json = JSON.stringify(body);
						postSent = true;
						let response: Response;
						try {
							response = await fetch(url, {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: json,
							});
						} catch {
							// The host may have accepted it. Observe by id; never send it again.
							return;
						}
						if (response.status !== 200 && response.status !== 202)
							fail(
								await responseError(response),
								response.status >= 400 && response.status < 500,
							);
					} catch (cause) {
						if (!failed)
							fail(
								ActionError.Unreachable({
									message: `Could not send the run to Epicenter: ${String(cause)}`,
								}).error,
								!postSent,
							);
					} finally {
						settled = true;
						notify();
					}
				});
		}

		async function* events({
			after,
			signal,
		}: {
			after?: number;
			signal?: AbortSignal;
		} = {}): AsyncGenerator<RunEvent<unknown, unknown>> {
			let localCursor = 0;
			while (!signal?.aborted) {
				if (after === undefined) {
					while (localCursor < local.length) {
						if (signal?.aborted) return;
						const event = local[localCursor++];
						if (event) yield event;
					}
				}
				if (failed || settled) break;
				await notified(subscribe, signal);
			}
			if (failed || signal?.aborted) return;
			let cursor = after ?? 0;
			let failures = 0;
			while (!signal?.aborted) {
				let delivered = false;
				let openedAt: number | undefined;
				let closedNormally = false;
				try {
					const response = await fetch(`${url}/events?after=${cursor}`, {
						signal,
					});
					if (signal?.aborted) return;
					if (response.status === 404) {
						const event = {
							type: 'unknown',
							error: ActionError.Unreachable({
								message: `Epicenter has no run ${id} for ${app} ${action}: it was never accepted or has expired. It was not run again.`,
							}).error,
						} as const;
						observe(event);
						yield event;
						return;
					}
					const reader = response.body?.getReader();
					if (!reader) throw new Error('No event stream');
					const abort = () => {
						void reader.cancel().catch(() => {});
					};
					signal?.addEventListener('abort', abort, { once: true });
					try {
						if (!response.ok) throw new Error('Could not read events');
						if (response.status === 200) openedAt = Date.now();
						const decoder = new TextDecoder();
						let buffered = '';
						for (;;) {
							const { done, value } = await reader.read();
							if (signal?.aborted) return;
							buffered += decoder.decode(value, { stream: !done });
							let end = buffered.indexOf('\n');
							while (end >= 0 || (done && buffered.length > 0)) {
								if (signal?.aborted) return;
								const line = end >= 0 ? buffered.slice(0, end) : buffered;
								buffered = end >= 0 ? buffered.slice(end + 1) : '';
								if (line.trim()) {
									let event: RunEvent<unknown, unknown>;
									try {
										event = hostEvent(JSON.parse(line), answered);
									} catch {
										yield {
											type: 'disconnected',
											error: ActionError.Unreachable({
												message: 'Epicenter sent an invalid run event',
											}).error,
										};
										return;
									}
									if ('seq' in event && event.seq > cursor) {
										cursor = event.seq;
										delivered = true;
										const terminal = observe(event);
										yield event;
										if (terminal) return;
									}
								}
								end = buffered.indexOf('\n');
							}
							if (done) {
								closedNormally = true;
								break;
							}
						}
					} finally {
						signal?.removeEventListener('abort', abort);
						void reader.cancel().catch(() => {});
						reader.releaseLock();
					}
				} catch {
					if (signal?.aborted) return;
				}
				if (delivered || (closedNormally && openedAt !== undefined && Date.now() - openedAt >= 5000)) {
					failures = 0;
					continue;
				}
				if (++failures >= 6) {
					yield {
						type: 'disconnected',
						error: ActionError.Unreachable({
							message:
								'Lost the connection to Epicenter; the run may still be running. Attach again to follow it.',
						}).error,
					};
					return;
				}
				await pause(Math.min(500 * 2 ** failures, 10000), signal);
			}
		}

		return {
			id,
			app,
			action,
			events,
			async result({ signal } = {}) {
				if (terminal) return terminal;
				for await (const event of events({ signal })) {
					if (event.type === 'finished') return event.result;
					if (
						event.type === 'failed' ||
						event.type === 'interrupted' ||
						event.type === 'unknown' ||
						event.type === 'disconnected'
					)
						return Err(event.error);
				}
				return ActionError.Stopped({
					message: 'Stopped waiting for the run; it continues on the host',
				});
			},
			async cancel() {
				if (!postSent) {
					uploads.abort();
					fail(
						ActionError.Stopped({
							message:
								'Cancelled before Epicenter accepted the run; it was not run',
						}).error,
						true,
					);
					return Ok(null);
				}
				await admission;
				try {
					const response = await fetch(`${url}/cancel`, { method: 'POST' });
					if (response.status === 200 || response.status === 202)
						return Ok(null);
					if (response.status === 404)
						return ActionError.Refused({
							message: `Epicenter has no run ${id} to cancel`,
						});
					return ActionError.Unreachable({
						message: `Epicenter answered ${response.status} ${response.statusText}`,
					});
				} catch (cause) {
					return ActionError.Unreachable({
						message: `Could not cancel the run on Epicenter: ${String(cause)}`,
					});
				}
			},
		};
	}

	return {
		start(input: Record<string, unknown> = {}) {
			return createRun(crypto.randomUUID(), input);
		},
		attach(id: string) {
			return createRun(id);
		},
		pending() {
			return pendingRuns({ app }).filter((entry) => entry.action === action);
		},
	};
}

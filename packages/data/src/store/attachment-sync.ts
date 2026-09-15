import {
	attachmentStorageId,
	AttachmentTransferError,
	type AttachmentContent,
	type BlobStore,
	sameAttachmentContent,
} from '@epicenter/blobs';
import { ATTACHMENT_ROUTE } from '@epicenter/sync/attachment-route';

type Owner = {
	tableName: string;
	rowId: string;
	content: AttachmentContent;
	isCurrent(): boolean;
};
export type AttachmentTransferState = {
	tableName: string;
	rowId: string;
	presence: 'unknown' | 'local' | 'missing' | 'error';
	transfer: 'idle' | 'uploading' | 'downloading' | 'waiting' | 'failed';
	error?: AttachmentTransferError;
};
type Entry = {
	owner: Owner;
	state: AttachmentTransferState;
	next: number;
	failures: number;
	/** Installed bytes still need the live transfer's final generation admission. */
	needsAdmission?: boolean;
	controller?: AbortController;
};
export type AttachmentTransport = {
	baseURL: string;
	appId: string;
	library: 'personal' | 'shared';
	dataId: string;
	generation: number;
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
};

/** One opened library owns discovery, retries and publication of transfer state. */
export function createAttachmentSync({
	bytes,
	rows,
	save,
	assertUsable,
	onRetired,
	onObserverError,
}: {
	bytes?: BlobStore;
	rows(): Owner[];
	save(): Promise<boolean>;
	assertUsable(): void;
	onRetired(): void;
	onObserverError(cause: unknown): void;
}) {
	let remote: AttachmentTransport | undefined;
	let closed = false;
	let paused = false;
	let queued = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const entries = new Map<string, Entry>();
	const pending = new Set<Promise<void>>();
	const listeners = new Set<() => void>();
	let priority: string | undefined;
	const key = (owner: Pick<Owner, 'tableName' | 'rowId'>) =>
		`${owner.tableName}/${owner.rowId}`;
	function notify() {
		for (const listener of listeners) {
			try {
				listener();
			} catch (cause) {
				onObserverError(cause);
			}
		}
	}
	function current(entry: Entry) {
		return (
			!closed &&
			entries.get(key(entry.owner)) === entry &&
			entry.owner.isCurrent()
		);
	}
	function changed() {
		if (closed || !remote || !bytes?.attachments) return;
		const found = new Set<string>();
		for (const owner of rows()) {
			const address = key(owner);
			found.add(address);
			const existing = entries.get(address);
			if (
				existing?.owner.isCurrent() &&
				sameAttachmentContent(existing.owner.content, owner.content)
			)
				continue;
			existing?.controller?.abort();
			entries.set(address, {
				owner,
				next: 0,
				failures: 0,
				state: {
					tableName: owner.tableName,
					rowId: owner.rowId,
					presence: 'unknown',
					transfer: 'waiting',
				},
			});
		}
		for (const [address, entry] of entries) {
			if (found.has(address)) continue;
			entry.controller?.abort();
			entries.delete(address);
		}
		notify();
		schedule();
	}
	function schedule() {
		if (closed || queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			pump();
		});
	}
	function pump() {
		if (closed || !remote) return;
		clearTimeout(timer);
		timer = undefined;
		const ordered = [...entries.values()].sort(
			(a, b) =>
				Number(key(b.owner) === priority) - Number(key(a.owner) === priority),
		);
		for (const entry of ordered) {
			if (pending.size >= 2) break;
			if (entry.controller || entry.next > Date.now()) continue;
			if (paused && entry.state.presence === 'missing') continue;
			entry.controller = new AbortController();
			const controller = entry.controller;
			// Includes native byte I/O (five minutes) and authority verification
			// (ten minutes), with headroom for the small control requests.
			const deadline = setTimeout(() => {
				controller.abort(
					new DOMException('Attachment transfer timed out.', 'TimeoutError'),
				);
			}, 20 * 60_000);
			const work = attempt(entry, remote, entry.controller.signal).finally(
				() => {
					clearTimeout(deadline);
					entry.controller = undefined;
					pending.delete(work);
					schedule();
				},
			);
			pending.add(work);
		}
		let next = Infinity;
		for (const entry of entries.values()) {
			if (entry.controller || (paused && entry.state.presence === 'missing'))
				continue;
			next = Math.min(next, entry.next);
		}
		if (Number.isFinite(next) && pending.size < 2)
			timer = setTimeout(schedule, Math.max(0, next - Date.now()));
	}
	function failure(entry: Entry, error: AttachmentTransferError) {
		if (!current(entry)) return;
		const permanent =
			error.kind === 'conflict' ||
			(error.status !== undefined && [400, 413].includes(error.status));
		// A signed URL can expire with 403. Retry through fresh captured-account
		// authorization; a control refusal remains visible and backs off too.
		entry.state = {
			...entry.state,
			transfer: permanent ? 'failed' : 'waiting',
			error,
		};
		entry.next = permanent
			? Infinity
			: Date.now() +
				Math.min(60_000, 1_000 * 2 ** Math.min(entry.failures++, 6));
		notify();
	}
	async function control(
		owner: Owner,
		selected: AttachmentTransport,
		method: 'POST' | 'PUT' | 'GET',
		signal: AbortSignal,
	) {
		const url = new URL(
			ATTACHMENT_ROUTE.url(
				selected.baseURL,
				selected.appId,
				selected.library,
				selected.dataId,
				owner.tableName,
				owner.rowId,
			),
		);
		url.searchParams.set('generation', String(selected.generation));
		const response = await selected.fetch(url, {
			method,
			signal,
			...(method === 'GET'
				? {}
				: {
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							generation: selected.generation,
							content: owner.content,
						}),
					}),
		});
		if (response.status === 410) {
			await response.body?.cancel();
			onRetired();
			throw AttachmentTransferError.Failed({
				kind: 'transport',
				status: 410,
				cause: 'Captured generation retired.',
			}).error;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw AttachmentTransferError.Failed({
				kind: response.status === 409 ? 'conflict' : 'transport',
				status: response.status,
				cause: 'Attachment control request refused.',
			}).error;
		}
		return response;
	}
	async function ticket(response: Response): Promise<{
		url: string;
		requiredHeaders: Record<string, string>;
		content?: AttachmentContent;
	}> {
		const reader = response.body?.getReader();
		if (!reader) throw new Error('Missing attachment ticket.');
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				if (size > 16_384) {
					await reader.cancel();
					throw new Error('Attachment ticket too large.');
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const buffer = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, offset);
			offset += chunk.length;
		}
		const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
		if (
			!value ||
			typeof value !== 'object' ||
			!('url' in value) ||
			typeof value.url !== 'string'
		)
			throw new Error('Invalid attachment ticket.');
		const parsed = new URL(value.url);
		if (
			!['http:', 'https:'].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password
		)
			throw new Error('Invalid attachment ticket URL.');
		const headers = 'requiredHeaders' in value ? value.requiredHeaders : {};
		if (
			!headers ||
			typeof headers !== 'object' ||
			Array.isArray(headers) ||
			Object.values(headers).some((v) => typeof v !== 'string')
		)
			throw new Error('Invalid attachment ticket headers.');
		return {
			url: value.url,
			requiredHeaders: headers as Record<string, string>,
			content:
				'content' in value ? (value.content as AttachmentContent) : undefined,
		};
	}
	async function attempt(
		entry: Entry,
		selected: AttachmentTransport,
		signal: AbortSignal,
	) {
		const owner = entry.owner;
		const id = attachmentStorageId(owner.tableName, owner.rowId);
		const transfers = bytes!.attachments!;
		try {
			if (!current(entry)) return;
			const stat = await bytes!.stat(id);
			if (!current(entry)) return;
			if (stat.error && stat.error.name !== 'BlobNotFound') {
				entry.state.presence = 'error';
				throw AttachmentTransferError.Failed({
					kind: 'storage',
					cause: stat.error,
				}).error;
			}
			if (
				!stat.error &&
				(!stat.data.attachment ||
					!sameAttachmentContent(stat.data.attachment, owner.content))
			)
				throw AttachmentTransferError.Failed({
					kind: 'conflict',
					cause: 'Local content differs from its completed row.',
				}).error;
			entry.state.presence = stat.error ? 'missing' : 'local';
			if (stat.error) entry.needsAdmission = false;
			entry.state.error = undefined;
			notify();
			const upload =
				!stat.error &&
				stat.data.attachment?.pendingUpload &&
				stat.data.attachment.originGeneration === selected.generation;
			if (!upload && !stat.error && !entry.needsAdmission) {
				entry.next = Infinity;
				entry.state.transfer = 'idle';
				notify();
				return;
			}
			if (!upload && paused && !entry.needsAdmission) {
				entry.next = 0;
				return;
			}
			if (!(await save()))
				throw AttachmentTransferError.Failed({
					kind: 'storage',
					cause: 'Owning row persistence is not confirmed.',
				}).error;
			if (!current(entry) || signal.aborted) return;
			entry.state.transfer = upload ? 'uploading' : 'downloading';
			notify();
			if (upload) {
				const prepared = await control(owner, selected, 'POST', signal);
				if (!current(entry) || signal.aborted) {
					await prepared.body?.cancel();
					return;
				}
				if (prepared.status !== 204) {
					const signed = await ticket(prepared);
					if (!current(entry) || signal.aborted) return;
					const uploaded = await transfers.upload(
						id,
						owner.content,
						signed,
						signal,
					);
					if (!current(entry) || signal.aborted) return;
					// A lost response or 409/412 needs the server's actual-byte proof.
					if (uploaded.error && uploaded.error.kind !== 'transport')
						throw uploaded.error;
					const published = await control(owner, selected, 'PUT', signal);
					await published.body?.cancel();
				}
				if (!current(entry) || signal.aborted) return;
				const acknowledged = await transfers.acknowledge(
					id,
					owner.content,
					selected.generation,
				);
				if (acknowledged.error)
					throw AttachmentTransferError.Failed({
						kind: 'storage',
						cause: acknowledged.error,
					}).error;
			} else {
				if (!entry.needsAdmission) {
					const signed = await ticket(
						await control(owner, selected, 'GET', signal),
					);
					if (
						!signed.content ||
						!sameAttachmentContent(signed.content, owner.content)
					)
						throw AttachmentTransferError.Failed({
							kind: 'conflict',
							cause: 'Remote publication differs from its completed row.',
						}).error;
					if (!current(entry) || signal.aborted || paused) return;
					// Cancellation can race a completed immutable install. Keep the
					// admission obligation if the next stat finds those bytes.
					entry.needsAdmission = true;
					const downloaded = await transfers.download(
						id,
						owner.content,
						signed,
						signal,
					);
					if (downloaded.error) throw downloaded.error;
				}
				if (!current(entry) || signal.aborted) return;
				// Installed immutable bytes may remain after retirement, but never publish
				// a current-owner completion without a final generation admission.
				const admitted = await control(owner, selected, 'GET', signal);
				await admitted.body?.cancel();
				entry.needsAdmission = false;
			}
			if (!current(entry) || signal.aborted) return;
			entry.next = Infinity;
			entry.failures = 0;
			entry.state = {
				...entry.state,
				presence: 'local',
				transfer: 'idle',
				error: undefined,
			};
			notify();
		} catch (cause) {
			if (signal.aborted) return;
			failure(
				entry,
				cause &&
					typeof cause === 'object' &&
					'name' in cause &&
					cause.name === 'Failed' &&
					'kind' in cause
					? (cause as AttachmentTransferError)
					: AttachmentTransferError.Failed({ kind: 'transport', cause }).error,
			);
		} finally {
			// Byte adapters return Results on cancellation, while fetch rejects.
			// Classify the deadline once, regardless of how the awaited I/O settled.
			if (signal.aborted && signal.reason?.name === 'TimeoutError')
				failure(
					entry,
					AttachmentTransferError.Failed({
						kind: 'transport',
						cause: signal.reason,
					}).error,
				);
		}
	}
	function wake() {
		if (closed) return;
		for (const entry of entries.values()) {
			if (entry.state.transfer === 'waiting') entry.next = 0;
		}
		schedule();
	}
	return {
		value: {
			status() {
				assertUsable();
				return {
					enabled: remote !== undefined,
					downloadsPaused: paused,
					items: [...entries.values()].map(({ state }) => ({ ...state })),
				};
			},
			subscribe(listener: () => void) {
				assertUsable();
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			pauseDownloads() {
				assertUsable();
				paused = true;
				for (const entry of entries.values())
					if (entry.state.transfer === 'downloading') {
						entry.controller?.abort();
						entry.state.transfer = 'waiting';
						entry.next = 0;
					}
				notify();
				schedule();
			},
			resumeDownloads() {
				assertUsable();
				paused = false;
				wake();
				notify();
			},
			retry() {
				assertUsable();
				for (const entry of entries.values()) {
					entry.next = 0;
					entry.failures = 0;
				}
				schedule();
			},
			prioritize(tableName: string, rowId: string) {
				assertUsable();
				priority = key({ tableName, rowId });
				wake();
			},
		},
		start(selected: AttachmentTransport) {
			if (closed) return;
			remote = Object.freeze({ ...selected });
			changed();
		},
		changed,
		wake,
		async close() {
			closed = true;
			clearTimeout(timer);
			for (const entry of entries.values()) entry.controller?.abort();
			listeners.clear();
			await Promise.allSettled(pending);
		},
	};
}

export type LibraryAttachments = ReturnType<
	typeof createAttachmentSync
>['value'];

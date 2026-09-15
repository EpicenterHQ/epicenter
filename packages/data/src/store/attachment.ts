import {
	attachmentStorageId,
	type BlobSource,
	type BlobSources,
	type BlobStat,
	type BlobStore,
} from '@epicenter/blobs';
import type { BlobDestination } from '@epicenter/blobs/native';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { PersistenceCapability } from './persistence.js';

export const AttachmentError = defineErrors({
	Unavailable: ({
		reason,
	}: {
		reason:
			| 'closed'
			| 'row-absent'
			| 'incomplete'
			| 'local-bytes'
			| 'storage-unconfigured';
	}) => ({ message: `Attachment unavailable: ${reason}.`, reason }),
	AlreadyCompleted: () => ({
		message: 'This row already owns immutable attachment bytes.',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'The attachment operation failed.',
		cause,
	}),
	PersistenceBlocked: () => ({
		message: 'Attachment completion has not been saved durably.',
	}),
});
export type AttachmentError = InferErrors<typeof AttachmentError>;

type AttachmentEngine = {
	storageId: ReturnType<typeof attachmentStorageId>;
	destination?: BlobDestination;
	generation(): number | null | undefined;
	prepare(): Promise<Result<void, AttachmentError>>;
	/** Only a capture's durable journal authorizes recovering a historical null cell. */
	completeFromLocal(
		contentType: string,
	): Promise<Result<void, AttachmentError>>;
};
const engines = new WeakMap<Attachment, AttachmentEngine>();

/** Internal recorder integration; deliberately absent from the package's application barrel. */
export function attachmentEngineOf(attachment: Attachment): AttachmentEngine {
	const engine = engines.get(attachment);
	if (!engine) throw new TypeError('Not a store-owned attachment.');
	return engine;
}

/** One row's byte owner, closing over the opened store and the original row container. */
export function createAttachment({
	tableName,
	rowId,
	signal,
	bytes,
	sources,
	destination,
	generation,
	persistence,
	exists,
	cell,
	commit,
	run,
	busy,
}: {
	tableName: string;
	rowId: string;
	signal: AbortSignal;
	bytes?: BlobStore;
	sources?: BlobSources;
	destination?: BlobDestination;
	generation?: () => number | null;
	persistence: PersistenceCapability;
	exists(): boolean;
	cell(): unknown;
	commit(contentType: string | null): void;
	run<T>(operation: () => Promise<T>): Promise<T>;
	busy: Set<string>;
}) {
	const storageId = attachmentStorageId(tableName, rowId);
	let staged: Blob | undefined;
	function ownSource(source: BlobSource): BlobSource {
		let disposed = false;
		function dispose() {
			if (disposed) return;
			disposed = true;
			signal.removeEventListener('abort', dispose);
			source[Symbol.dispose]();
		}
		signal.addEventListener('abort', dispose, { once: true });
		return { url: source.url, [Symbol.dispose]: dispose };
	}
	function unavailable() {
		if (signal.aborted)
			return AttachmentError.Unavailable({ reason: 'closed' });
		if (!exists()) return AttachmentError.Unavailable({ reason: 'row-absent' });
		if (!bytes)
			return AttachmentError.Unavailable({ reason: 'storage-unconfigured' });
		return undefined;
	}
	async function operate<T>(
		operation: () => Promise<Result<T, AttachmentError>>,
	): Promise<Result<T, AttachmentError>> {
		const refusal = unavailable();
		if (refusal) return refusal;
		try {
			return await run(operation);
		} catch (cause) {
			return unavailable() ?? AttachmentError.Failed({ cause });
		}
	}
	async function prepare(): Promise<Result<void, AttachmentError>> {
		const refusal = unavailable();
		if (refusal) return refusal;
		if (cell() !== null) return AttachmentError.AlreadyCompleted();
		await persistence.flush();
		const after = unavailable();
		if (after) return after;
		if (cell() !== null) return AttachmentError.AlreadyCompleted();
		return persistence.get() === 'saved'
			? Ok(undefined)
			: AttachmentError.PersistenceBlocked();
	}
	async function publish(
		contentType: string,
	): Promise<Result<void, AttachmentError>> {
		const refusal = unavailable();
		if (refusal) return refusal;
		if (cell() !== null) return AttachmentError.AlreadyCompleted();
		commit(contentType);
		await persistence.flush();
		const after = unavailable();
		if (after) return after;
		if (persistence.get() !== 'saved') {
			// Bytes remain recoverable. The live cell must not promise saved audio.
			commit(null);
			return AttachmentError.PersistenceBlocked();
		}
		return Ok(undefined);
	}
	async function exclusively(
		operation: () => Promise<Result<void, AttachmentError>>,
	) {
		return operate(async () => {
			if (busy.has(storageId)) return AttachmentError.AlreadyCompleted();
			busy.add(storageId);
			try {
				return await operation();
			} finally {
				busy.delete(storageId);
			}
		});
	}
	const attachment = Object.freeze({
		tableName,
		rowId,
		signal,
		/** Persist the row, immutable local bytes, and completion before reporting success. */
		complete(blob: Blob): Promise<Result<void, AttachmentError>> {
			return exclusively(async () => {
				const prepared = await prepare();
				if (prepared.error) return prepared;
				if (staged) {
					const [previous, next] = await Promise.all([
						staged.arrayBuffer(),
						blob.arrayBuffer(),
					]);
					const nextBytes = new Uint8Array(next);
					if (
						staged.type !== blob.type ||
						previous.byteLength !== next.byteLength ||
						!new Uint8Array(previous).every(
							(value, index) => value === nextBytes[index],
						)
					)
						return AttachmentError.AlreadyCompleted();
				} else {
					const written = await bytes!.put(storageId, blob);
					if (written.error)
						return written.error.name === 'BlobAlreadyExists'
							? AttachmentError.AlreadyCompleted()
							: AttachmentError.Failed({ cause: written.error });
					staged = blob;
				}
				const completed = await publish(
					blob.type || 'application/octet-stream',
				);
				if (!completed.error) staged = undefined;
				return completed;
			});
		},
		/** Read this device only. A completed cell never substitutes for local bytes. */
		stat(): Promise<Result<BlobStat, AttachmentError>> {
			return operate(async () => {
				if (typeof cell() !== 'string')
					return AttachmentError.Unavailable({ reason: 'incomplete' });
				const result = await bytes!.stat(storageId);
				const after = unavailable();
				if (after) return after;
				if (result.error)
					return result.error.name === 'BlobNotFound'
						? AttachmentError.Unavailable({ reason: 'local-bytes' })
						: AttachmentError.Failed({ cause: result.error });
				return Ok(result.data);
			});
		},
		/** Read this device only. A completed cell never substitutes for local bytes. */
		read(): Promise<Result<Blob, AttachmentError>> {
			return operate(async () => {
				if (typeof cell() !== 'string')
					return AttachmentError.Unavailable({ reason: 'incomplete' });
				const result = await bytes!.get(storageId);
				const after = unavailable();
				if (after) return after;
				if (result.error)
					return result.error.name === 'BlobNotFound'
						? AttachmentError.Unavailable({ reason: 'local-bytes' })
						: AttachmentError.Failed({ cause: result.error });
				return Ok(result.data);
			});
		},
		/** Acquire independently disposable local playback; native sources stream without loading audio into the WebView. */
		source(): Promise<Result<BlobSource, AttachmentError>> {
			return operate(async () => {
				if (typeof cell() !== 'string')
					return AttachmentError.Unavailable({ reason: 'incomplete' });
				if (sources) {
					const result = await sources.open(storageId);
					const after = unavailable();
					if (after) {
						result.data?.[Symbol.dispose]();
						return after;
					}
					if (result.error)
						return result.error.name === 'BlobNotFound'
							? AttachmentError.Unavailable({ reason: 'local-bytes' })
							: AttachmentError.Failed({ cause: result.error });
					return Ok(ownSource(result.data));
				}
				const result = await attachment.read();
				if (result.error) return Err(result.error);
				const after = unavailable();
				if (after) return after;
				const url = URL.createObjectURL(result.data);
				return Ok(
					ownSource({
						url,
						[Symbol.dispose]() {
							URL.revokeObjectURL(url);
						},
					}),
				);
			});
		},
	});
	engines.set(attachment, {
		storageId,
		destination,
		generation: () => generation?.(),
		prepare: () =>
			operate(async () => {
				const prepared = await prepare();
				if (prepared.error) return prepared;
				const stat = await bytes!.stat(storageId);
				const after = unavailable();
				if (after) return after;
				if (!stat.error) return AttachmentError.AlreadyCompleted();
				return stat.error.name === 'BlobNotFound'
					? Ok(undefined)
					: AttachmentError.Failed({ cause: stat.error });
			}),
		completeFromLocal(contentType) {
			return exclusively(async () => {
				await persistence.flush();
				const after = unavailable();
				if (after) return after;
				if (persistence.get() !== 'saved')
					return AttachmentError.PersistenceBlocked();
				if (cell() !== null && cell() !== contentType)
					return AttachmentError.AlreadyCompleted();
				const stat = await bytes!.stat(storageId);
				if (stat.error)
					return stat.error.name === 'BlobNotFound'
						? AttachmentError.Unavailable({ reason: 'local-bytes' })
						: AttachmentError.Failed({ cause: stat.error });
				if (
					!contentType ||
					stat.data.contentType !== contentType ||
					stat.data.size === 0
				)
					return AttachmentError.Failed({
						cause: 'Published capture metadata does not match its completion.',
					});
				const current = unavailable();
				if (current) return current;
				if (cell() === contentType) return Ok(undefined);
				return publish(contentType);
			});
		},
	});
	return attachment;
}
export type Attachment = ReturnType<typeof createAttachment>;

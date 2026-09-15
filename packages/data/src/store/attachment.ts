import {
	attachmentStorageId,
	type AttachmentContent,
	type BlobSource,
	type BlobSources,
	type BlobStat,
	type BlobStore,
	sameAttachmentContent,
} from '@epicenter/blobs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

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
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'The attachment operation failed.',
		cause,
	}),
	SaveUnconfirmed: ({ rowId }: { rowId: string }) => ({
		message:
			'Attachment publication or row persistence could not be confirmed. Do not replace this address.',
		rowId,
	}),
});
export type AttachmentError = InferErrors<typeof AttachmentError>;

type AttachmentEngine = {
	storageId: ReturnType<typeof attachmentStorageId>;
	evidence(): AttachmentContent | undefined;
};
const engines = new WeakMap<Attachment, AttachmentEngine>();

/** Internal library integration, absent from the application barrel. */
export function attachmentEngineOf(attachment: Attachment): AttachmentEngine {
	const engine = engines.get(attachment);
	if (!engine) throw new TypeError('Not a store-owned attachment.');
	return engine;
}

/** An existing immutable row's local bytes. Reads never perform network I/O. */
export function createAttachment({
	tableName,
	rowId,
	signal,
	bytes,
	sources,
	exists,
	cell,
	evidence,
	run,
}: {
	tableName: string;
	rowId: string;
	signal: AbortSignal;
	bytes?: BlobStore;
	sources?: BlobSources;
	exists(): boolean;
	cell(): unknown;
	evidence(): AttachmentContent | undefined;
	run<T>(operation: () => Promise<T>): Promise<T>;
}) {
	const storageId = attachmentStorageId(tableName, rowId);
	function unavailable() {
		if (signal.aborted)
			return AttachmentError.Unavailable({ reason: 'closed' });
		if (!exists()) return AttachmentError.Unavailable({ reason: 'row-absent' });
		if (!bytes)
			return AttachmentError.Unavailable({ reason: 'storage-unconfigured' });
		if (typeof cell() !== 'string')
			return AttachmentError.Unavailable({ reason: 'incomplete' });
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
	const attachment = Object.freeze({
		tableName,
		rowId,
		signal,
		stat(): Promise<Result<BlobStat, AttachmentError>> {
			return operate(async () => {
				const result = await bytes!.stat(storageId);
				const after = unavailable();
				if (after) return after;
				if (result.error)
					return result.error.name === 'BlobNotFound'
						? AttachmentError.Unavailable({ reason: 'local-bytes' })
						: AttachmentError.Failed({ cause: result.error });
				const expected = evidence();
				if (
					expected &&
					(!result.data.attachment ||
						!sameAttachmentContent(expected, result.data.attachment))
				)
					return AttachmentError.Failed({
						cause: 'Local bytes do not match the owning row content evidence.',
					});
				return Ok(result.data);
			});
		},
		read(): Promise<Result<Blob, AttachmentError>> {
			return operate(async () => {
				const present = await attachment.stat();
				if (present.error) return Err(present.error);
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
		/** Native playback streams from the host without loading audio into the WebView. */
		source(): Promise<Result<BlobSource, AttachmentError>> {
			return operate(async () => {
				if (sources) {
					const present = await attachment.stat();
					if (present.error) return Err(present.error);
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
	engines.set(attachment, { storageId, evidence });
	return attachment;
}
export type Attachment = ReturnType<typeof createAttachment>;

/**
 * Unmounted library backup coordinator. The application-side codec validates
 * content; the stable authority publishes only after immutable storage read-back.
 * Failed publication retains the exact request in this lifetime. Durable intent
 * recovery across page restart and destructive restore are separate checkpoints.
 */
import {
	type BlobId,
	type BlobNotFound,
	type BlobStore,
	type BlobStoreFailed,
	generateBlobId,
} from '@epicenter/blobs';
import { Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import {
	ArchiveError,
	type ArchiveIdentity,
	captureArchive,
	prepareArchive,
} from './artifact/archive.js';
import type { CurrentAuthority } from './sync/authority.js';
import { BackupError, type BackupRecord } from './sync/backups.js';

export function createLibraryRecovery({
	authority,
	library,
	identity,
	blobs,
	archives,
}: {
	authority: CurrentAuthority;
	library: string;
	identity: ArchiveIdentity;
	blobs: Pick<BlobStore, 'get'>;
	archives: Pick<BlobStore, 'put' | 'get'>;
}) {
	identity = { ...identity };
	const backups = authority.backups({ library, identity, archives });
	type Publication = Parameters<typeof backups.publish>[0];
	let pending: Publication | undefined;
	let running = false;

	async function metadata(bytes: Uint8Array) {
		const prepared = await prepareArchive(bytes);
		if (prepared.error !== null) return prepared;
		if (
			prepared.data.identity.appId !== identity.appId ||
			prepared.data.identity.dataId !== identity.dataId
		)
			return ArchiveError.InvalidArchive({
				cause: 'Archive belongs to another application or data definition',
			});
		return Ok({
			...prepared.data.identity,
			version: prepared.data.version,
			source: prepared.data.source,
		});
	}
	async function publish(
		bytes: Uint8Array,
		reason: 'manual' | 'imported',
	): Promise<Result<BackupRecord, ArchiveError | BackupError>> {
		if (pending) {
			if (
				pending.reason !== reason ||
				pending.bytes.length !== bytes.length ||
				pending.bytes.some((byte, index) => byte !== bytes[index])
			)
				return BackupError.BackupFailed({
					cause: 'A different backup publication is pending',
				});
		} else {
			const verified = await metadata(bytes);
			if (verified.error !== null) return verified;
			pending = {
				id: generateBlobId(),
				reason,
				bytes,
				metadata: verified.data,
			};
		}
		const result = await backups.publish(pending);
		if (result.error === null) pending = undefined;
		return result;
	}
	return {
		/** Capture accepted state once; retry a pending publication without recapture. */
		async backup(): Promise<
			Result<
				BackupRecord,
				ArchiveError | BackupError | BlobNotFound | BlobStoreFailed
			>
		> {
			if (running)
				return BackupError.BackupFailed({
					cause: 'A backup operation is running',
				});
			running = true;
			try {
				if (pending) return await publish(pending.bytes, 'manual');
				const captured = trySync({
					try: () => authority.capture(),
					catch: (cause) => BackupError.BackupFailed({ cause }),
				});
				if (captured.error !== null) return captured;
				const archive = await captureArchive(captured.data, blobs, identity);
				if (archive.error !== null) return archive;
				return await publish(new Uint8Array(archive.data), 'manual');
			} finally {
				running = false;
			}
		},
		/** Save the file unchanged. Import never activates a generation. */
		async import(
			file: Blob,
		): Promise<Result<BackupRecord, ArchiveError | BackupError>> {
			if (running)
				return BackupError.BackupFailed({
					cause: 'A backup operation is running',
				});
			running = true;
			try {
				const read = await tryAsync({
					try: async () => new Uint8Array(await file.arrayBuffer()),
					catch: (cause) => ArchiveError.InvalidArchive({ cause }),
				});
				if (read.error !== null) return read;
				return await publish(read.data, 'imported');
			} finally {
				running = false;
			}
		},
		list() {
			return backups.list();
		},
		async download(
			id: BlobId,
		): Promise<Result<Uint8Array<ArrayBuffer>, ArchiveError | BackupError>> {
			const saved = await backups.download(id);
			if (saved.error !== null) return saved;
			const verified = await metadata(saved.data);
			if (verified.error !== null) return verified;
			return saved;
		},
	};
}

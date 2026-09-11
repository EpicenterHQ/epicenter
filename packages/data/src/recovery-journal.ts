/**
 * The client-side record of what a person asked for, before anything was sent.
 *
 * A publication is two writes that cannot share a transaction: bytes into
 * immutable object storage, then a row in the authority's catalog. Losing the
 * page between them used to lose the capture itself, because the only copy of
 * those bytes was a closure. Re-capturing is not a retry: accepted writes have
 * landed since, so it would publish a different library state under the same
 * intent. The journal exists so the exact bytes outlive the lifetime that made
 * them.
 *
 * It is deliberately not the replica. A restore invalidates and reloads the
 * cached document, and the record of the restore has to survive precisely that
 * event, so the journal is addressed separately and the address carries the
 * full server/account/application/library identity: one library's pending
 * intent must never be resumed against another's.
 *
 * Storage is a port rather than a concrete engine because the durable thing in
 * a browser, in Bun, and in a test are three different objects, and none of
 * them belongs in this file. `store/idb-journal.ts` is the browser one.
 */
import type { BlobId } from '@epicenter/blobs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import {
	type BackupMetadata,
	type BackupReason,
	digestHex,
} from './sync/backups.js';

/**
 * A publication that has been decided and not yet published.
 *
 * `bytes` is the whole point: the reserved id alone cannot recover a capture
 * whose object was never uploaded.
 */
export type PublicationIntent = {
	kind: 'publication';
	id: BlobId;
	reason: BackupReason;
	metadata: BackupMetadata;
	bytes: Uint8Array;
};

/**
 * A restore that has been started and not yet resolved.
 *
 * Mostly a pointer: the attempt's own record lives under the authority, which
 * survives the generation replacement, and this is what tells a freshly loaded
 * page there is something to reconcile before it treats a repeated user action
 * as a new one.
 *
 * `safety` is the exception, and it is here rather than under the authority for
 * the same reason a publication's bytes are: between capturing the destination
 * and publishing that capture, the journal holds the only copy. Once the record
 * is published the attempt names it by id and this field is dropped.
 */
export type RestoreIntent = {
	kind: 'restore';
	operation: string;
	backupId: BlobId;
	safety?: Omit<PublicationIntent, 'kind'>;
};

export type RecoveryIntent = PublicationIntent | RestoreIntent;

export const JournalError = defineErrors({
	JournalFailed: ({ cause }: { cause: unknown }) => ({
		message: `Recovery journal operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type JournalError = InferErrors<typeof JournalError>;

/** One durable slot, already scoped to a single library by its address. */
export type JournalStorage = {
	read(key: string): Promise<Uint8Array | undefined>;
	write(key: string, bytes: Uint8Array): Promise<void>;
	clear(): Promise<void>;
};

/** The header is written last, so a torn pair never reads as a complete intent. */
const HEADER = 'intent';
const PAYLOAD = 'payload';

/** What the header says about the one payload slot, when the intent uses it. */
type Payload = { digest: string; byteLength: number };

/** An intent with its byte string lifted out into the payload slot. */
type StoredIntent =
	| Omit<PublicationIntent, 'bytes'>
	| (Omit<RestoreIntent, 'safety'> & {
			safety?: Omit<PublicationIntent, 'kind' | 'bytes'>;
	  });
type Header = { intent: StoredIntent; payload?: Payload };

/**
 * Split an intent into the header and the at most one byte string it carries.
 *
 * Exactly one slot, whichever kind of intent holds it: a publication's own
 * bytes, or a restore's not-yet-published destination capture. Two slots would
 * mean two unresolved publications, which is the state the single-slot journal
 * exists to make unrepresentable.
 */
function detach(intent: RecoveryIntent): {
	intent: StoredIntent;
	bytes?: Uint8Array;
} {
	if (intent.kind === 'publication') {
		const { bytes, ...stored } = intent;
		return { intent: stored, bytes };
	}
	const { safety, ...stored } = intent;
	if (safety === undefined) return { intent: stored };
	const { bytes, ...retained } = safety;
	return { intent: { ...stored, safety: retained }, bytes };
}

/**
 * Address one library's journal.
 *
 * Every component is load-bearing. The same application and data definition
 * exist under a different account and against a different server, and resuming
 * one library's publication into another is the one mistake this record must
 * make impossible.
 *
 * Throws rather than returning a Result, unlike the rest of this module: an
 * incomplete identity is a caller assembling the address wrong, not a storage
 * failure a person can retry past.
 */
export function recoveryJournalAddress(identity: {
	server: string;
	account: string;
	appId: string;
	dataId: string;
	library: string;
}): string {
	const parts = [
		identity.server,
		identity.account,
		identity.appId,
		identity.dataId,
		identity.library,
	];
	if (parts.some((part) => !part))
		throw new Error('A recovery journal address needs a complete identity');
	return `epicenter.recovery-journal/${parts.map(encodeURIComponent).join('/')}`;
}

export type RecoveryJournal = ReturnType<typeof createRecoveryJournal>;

/**
 * One intent at a time.
 *
 * A single slot is the enforcement of "another operation is refused while this
 * one is unresolved". Two slots would let a second capture start while the
 * first still owns a reserved catalog id, and nothing downstream could tell
 * which one a later retry meant.
 */
export function createRecoveryJournal(storage: JournalStorage) {
	return {
		/**
		 * The retained intent, or nothing.
		 *
		 * A publication whose payload is missing, short, or hashes differently is
		 * a torn write, not an intent: it is cleared rather than resumed, because
		 * publishing bytes this record cannot vouch for is worse than losing the
		 * capture it was meant to protect.
		 */
		async load(): Promise<Result<RecoveryIntent | undefined, JournalError>> {
			return tryAsync({
				try: async () => {
					const stored = await storage.read(HEADER);
					if (stored === undefined) return undefined;
					const header = JSON.parse(new TextDecoder().decode(stored)) as Header;
					const expects =
						header.intent.kind === 'publication' ||
						header.intent.safety !== undefined;
					if (!expects) return header.intent as RestoreIntent;
					const bytes = await storage.read(PAYLOAD);
					if (
						header.payload === undefined ||
						bytes === undefined ||
						bytes.length !== header.payload.byteLength ||
						(await digestHex(bytes)) !== header.payload.digest
					) {
						await storage.clear();
						return undefined;
					}
					if (header.intent.kind === 'publication')
						return { ...header.intent, bytes } satisfies PublicationIntent;
					const { safety, ...intent } = header.intent;
					return {
						...intent,
						safety: {
							...(safety as Omit<PublicationIntent, 'kind' | 'bytes'>),
							bytes,
						},
					} satisfies RestoreIntent;
				},
				catch: (cause) => JournalError.JournalFailed({ cause }),
			});
		},

		/** Persist the intent before the first mutating request it authorizes. */
		async record(intent: RecoveryIntent): Promise<Result<void, JournalError>> {
			return tryAsync({
				try: async () => {
					const detached = detach(intent);
					const bytes =
						detached.bytes === undefined
							? undefined
							: new Uint8Array(detached.bytes);
					if (bytes !== undefined && bytes.length === 0)
						throw new Error('A retained capture needs bytes');
					const header: Header = {
						intent: detached.intent,
						payload:
							bytes === undefined
								? undefined
								: { digest: await digestHex(bytes), byteLength: bytes.length },
					};
					// Payload first: the header is the commit marker for the pair.
					if (bytes !== undefined) await storage.write(PAYLOAD, bytes);
					await storage.write(
						HEADER,
						new TextEncoder().encode(JSON.stringify(header)),
					);
				},
				catch: (cause) => JournalError.JournalFailed({ cause }),
			});
		},

		/** Release the slot. Only a resolved outcome may call this. */
		async clear(): Promise<Result<void, JournalError>> {
			return tryAsync({
				try: () => storage.clear(),
				catch: (cause) => JournalError.JournalFailed({ cause }),
			});
		},
	};
}

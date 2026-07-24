import type { RecordAddress } from '../protocol/v1/index.js';
import type { ReplicaBlobStore, ReplicaStore } from '../store/replica/index.js';

export type BlockedWork =
	| {
			plane: 'scalar';
			reason: 'fact-too-large';
			measuredBytes: number;
			limitBytes: number;
	  }
	| { plane: 'scalar'; reason: 'patch-base-not-object' }
	/**
	 * The named revision exceeded the authority document bound. No measurement
	 * is carried: the authority measures the merged post-join state, which this
	 * replica cannot reproduce from its own document alone.
	 */
	| { plane: 'document'; reason: 'document-bound'; revision: number }
	| { plane: 'blob'; reason: 'blob-conflict' | 'record-not-live' };

export type PublicationStatus =
	| { state: 'settled' }
	| { state: 'ready' }
	| { state: 'blocked'; blocked: [BlockedWork, ...BlockedWork[]] };

export function publicationStatus(
	store: ReplicaStore,
	blobs: Pick<ReplicaBlobStore<never, never>, 'inspect'> | null,
	address: RecordAddress,
): PublicationStatus {
	const blocked: BlockedWork[] = [];
	let owed = false;
	const lanes = store.record(address);
	if (lanes?.parked !== null && lanes?.parked !== undefined) {
		if (
			lanes.parked.code === 'fact-too-large' &&
			(lanes.parked.measuredBytes === undefined ||
				lanes.parked.limitBytes === undefined)
		) {
			throw new Error('parked scalar measurement is incomplete');
		}
		blocked.push(
			lanes.parked.code === 'fact-too-large'
				? {
						plane: 'scalar',
						reason: 'fact-too-large',
						measuredBytes: lanes.parked.measuredBytes as number,
						limitBytes: lanes.parked.limitBytes as number,
					}
				: { plane: 'scalar', reason: 'patch-base-not-object' },
		);
	} else if (
		lanes !== null &&
		(lanes.pending !== null || lanes.sealed !== null)
	) {
		owed = true;
	}

	const document = store.inspectDocument(address);
	if (document !== null && document.refusedRevision !== null) {
		blocked.push({
			plane: 'document',
			reason: 'document-bound',
			revision: document.refusedRevision,
		});
	} else if (document?.owed) {
		owed = true;
	}

	const blob = blobs?.inspect(address);
	if (blob?.kind === 'parked') {
		if (blob.parkedCode === undefined) {
			throw new Error('parked blob reason is missing');
		}
		blocked.push({
			plane: 'blob',
			reason: blob.parkedCode,
		});
	} else if (blob?.kind === 'owed') {
		owed = true;
	}

	return blocked.length > 0
		? {
				state: 'blocked',
				blocked: blocked as [BlockedWork, ...BlockedWork[]],
			}
		: owed
			? { state: 'ready' }
			: { state: 'settled' };
}

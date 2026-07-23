import type { SyncAuthClient } from '@epicenter/auth';
import type { BoundLens } from '@epicenter/data/runtime';
import {
	openBrowserEpicenter,
	retireUnclaimedBrowserReplica,
} from '@epicenter/data/runtime/browser';
import { whisperingLens } from '../workspace';
import {
	openWhisperingBrowserEpicenter,
	whisperingReplicaOwner,
} from './whispering.browser-runtime';

type WhisperingAuth = Pick<SyncAuthClient, 'state' | 'deployment' | 'fetch'>;

type WhisperingBound = BoundLens<typeof whisperingLens, Blob, Blob>;

export type UnclaimedImportCounts = {
	recordings: number;
	recipes: number;
};

/**
 * Explicit, user-confirmed import from this origin's unclaimed replica into
 * the signed-in account's replica (ADR-0178). Whispering imports its durable
 * content tables, recordings and recipes, but keeps account settings
 * authoritative. Import reads through the source Lens and writes through
 * ordinary destination record operations, preserving record keys so a retry
 * rewrites the same logical records. After every write reads back, the same
 * confirmed operation retires the unclaimed replica.
 */
export type WhisperingUnclaimedImport = {
	/**
	 * Lens-visible data in the unclaimed replica, or `null` when there is
	 * nothing to offer (signed out, or the unclaimed replica is empty).
	 */
	preview(): Promise<UnclaimedImportCounts | null>;
	/** Import durable content, verify it, then retire the unclaimed replica. */
	importAndRetire(): Promise<
		| { kind: 'retired'; counts: UnclaimedImportCounts }
		| {
				kind: 'retirement-failed';
				counts: UnclaimedImportCounts;
				reason: 'held' | 'failed';
				cause?: unknown;
		  }
	>;
};

async function withUnclaimed<TResult>(
	work: (bound: WhisperingBound) => Promise<TResult>,
): Promise<TResult> {
	const runtime = await openBrowserEpicenter({ owner: null });
	try {
		return await work(runtime.bind(whisperingLens) as WhisperingBound);
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
}

async function readCounts(
	bound: WhisperingBound,
): Promise<UnclaimedImportCounts> {
	let recordings = 0;
	for await (const row of bound.recordings.entries()) {
		if (row.error !== null) throw row.error;
		recordings += 1;
	}
	let recipes = 0;
	for await (const row of bound.recipes.entries()) {
		if (row.error !== null) throw row.error;
		recipes += 1;
	}
	return { recordings, recipes };
}

export function createWhisperingUnclaimedImport(
	auth: WhisperingAuth,
): WhisperingUnclaimedImport {
	return {
		async preview() {
			if (whisperingReplicaOwner(auth) === null) return null;
			const counts = await withUnclaimed(readCounts);
			return counts.recordings + counts.recipes === 0 ? null : counts;
		},

		async importAndRetire() {
			if (whisperingReplicaOwner(auth) === null) {
				throw new Error('importing local data requires a signed-in account');
			}
			const destinationRuntime = await openWhisperingBrowserEpicenter({ auth });
			let imported: UnclaimedImportCounts;
			try {
				const destination = destinationRuntime.bind(
					whisperingLens,
				) as WhisperingBound;
				imported = await withUnclaimed(async (source) => {
					const counts: UnclaimedImportCounts = {
						recordings: 0,
						recipes: 0,
					};
					const importedRowIds: {
						table: 'recordings' | 'recipes';
						id: string;
					}[] = [];
					for (const table of ['recordings', 'recipes'] as const) {
						for await (const row of source[table].entries()) {
							if (row.error !== null) throw row.error;
							const { id, ...fields } = row.data;
							const { error } = await destination[table].put(
								id,
								fields as never,
							);
							if (error !== null) throw error;
							counts[table] += 1;
							importedRowIds.push({ table, id });
						}
					}
					// Verified import: every write reads back through the destination
					// Lens before the unclaimed replica is retired.
					for (const { table, id } of importedRowIds) {
						const { data, error } = await destination[table].record(id).get();
						if (error !== null) throw error;
						if (data === undefined) {
							throw new Error(
								`imported ${table} record ${id} did not read back`,
							);
						}
					}
					return counts;
				});
			} finally {
				await destinationRuntime[Symbol.asyncDispose]();
			}

			try {
				const retirement = await retireUnclaimedBrowserReplica();
				return retirement.kind === 'retired'
					? { kind: 'retired', counts: imported }
					: {
							kind: 'retirement-failed',
							counts: imported,
							reason: 'held',
						};
			} catch (cause) {
				return {
					kind: 'retirement-failed',
					counts: imported,
					reason: 'failed',
					cause,
				};
			}
		},
	};
}

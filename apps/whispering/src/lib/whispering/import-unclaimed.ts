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

const SETTING_KEYS = Object.keys(
	whisperingLens.collections.settings.values,
) as (keyof (typeof whisperingLens)['collections']['settings']['values'] &
	string)[];

export type UnclaimedImportCounts = {
	recordings: number;
	recipes: number;
	settings: number;
};

export type UnclaimedImportSelection = {
	recordings: boolean;
	recipes: boolean;
	settings: boolean;
};

/**
 * Explicit, user-confirmed import from this origin's unclaimed replica into
 * the signed-in account's replica (ADR-0178). Import reads through the
 * source Lens and writes through ordinary destination record operations,
 * preserving record keys so a retry rewrites identical records. Sign-in
 * never calls any of this implicitly; retirement is a separate explicit step
 * offered only after `importSelected` verified its writes.
 */
export type WhisperingUnclaimedImport = {
	/**
	 * Lens-visible data in the unclaimed replica, or `null` when there is
	 * nothing to offer (signed out, or the unclaimed replica is empty).
	 */
	preview(): Promise<UnclaimedImportCounts | null>;
	/** Import the selected collections and verify every write read back. */
	importSelected(
		selection: UnclaimedImportSelection,
	): Promise<UnclaimedImportCounts>;
	/** Destroy the unclaimed replica's storage; refuses while it is open. */
	retire(): Promise<'retired' | 'held'>;
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

async function readCounts(bound: WhisperingBound): Promise<UnclaimedImportCounts> {
	let recordings = 0;
	for await (const row of bound.recordings.entries()) {
		if (row.error === null) recordings += 1;
	}
	let recipes = 0;
	for await (const row of bound.recipes.entries()) {
		if (row.error === null) recipes += 1;
	}
	let settings = 0;
	for (const key of SETTING_KEYS) {
		const { data, error } = await bound.settings.record(key).get();
		if (error === null && data !== undefined) settings += 1;
	}
	return { recordings, recipes, settings };
}

export function createWhisperingUnclaimedImport(
	auth: WhisperingAuth,
): WhisperingUnclaimedImport {
	return {
		async preview() {
			if (whisperingReplicaOwner(auth) === null) return null;
			const counts = await withUnclaimed(readCounts);
			return counts.recordings + counts.recipes + counts.settings === 0
				? null
				: counts;
		},

		async importSelected(selection) {
			if (whisperingReplicaOwner(auth) === null) {
				throw new Error('importing local data requires a signed-in account');
			}
			const destinationRuntime = await openWhisperingBrowserEpicenter({ auth });
			try {
				const destination = destinationRuntime.bind(
					whisperingLens,
				) as WhisperingBound;
				return await withUnclaimed(async (source) => {
					const imported: UnclaimedImportCounts = {
						recordings: 0,
						recipes: 0,
						settings: 0,
					};
					const importedRowIds: {
						table: 'recordings' | 'recipes';
						id: string;
					}[] = [];
					for (const table of ['recordings', 'recipes'] as const) {
						if (!selection[table]) continue;
						for await (const row of source[table].entries()) {
							if (row.error !== null) continue;
							const { id, ...fields } = row.data;
							const { error } = await destination[table].put(
								id,
								fields as never,
							);
							if (error !== null) throw error;
							imported[table] += 1;
							importedRowIds.push({ table, id });
						}
					}
					if (selection.settings) {
						for (const key of SETTING_KEYS) {
							const { data, error } = await source.settings.record(key).get();
							if (error !== null || data === undefined) continue;
							const written = await destination.settings
								.record(key)
								.set(data as never);
							if (written.error !== null) throw written.error;
							imported.settings += 1;
						}
					}
					// Verified import: every written record reads back through the
					// destination Lens before retirement is ever offered.
					for (const { table, id } of importedRowIds) {
						const { data, error } = await destination[table].record(id).get();
						if (error !== null) throw error;
						if (data === undefined) {
							throw new Error(
								`imported ${table} record ${id} did not read back`,
							);
						}
					}
					return imported;
				});
			} finally {
				await destinationRuntime[Symbol.asyncDispose]();
			}
		},

		async retire() {
			return (await retireUnclaimedBrowserReplica()).kind;
		},
	};
}

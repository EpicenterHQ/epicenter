/**
 * Recipes, read straight out of the document.
 *
 * A user recipe's identity IS its minted row id, and the built-in ones ship in
 * code under a `builtin:` prefix and are not rows at all (`data.ts`,
 * ADR-0099, ADR-0206). So the `sourceId` column and the two-way id map that
 * used to live here are both gone.
 *
 * This is a `.svelte.ts` module because the state IS reactive state, and runes
 * own that. It previously held four `let`s, a `Set` of listeners, a `notify`
 * fanout and a `subscribe` method, which together reimplemented `$state` by
 * hand; and `pickable` was recomputed inside the read, which is what `$derived`
 * is for. It also held a generation counter, an `isDisposed` flag and a retry
 * loop, all of which arbitrated between asynchronous reads that could land out
 * of order. Reads are synchronous now (ADR-0215), so none of that can happen.
 */
import type { NonconformingRow } from '@epicenter/data';
import type { Recipe, WhisperingData } from '../data';
import { BUILTIN_RECIPES } from '../state/builtin-recipes';

/** The shipped recipes are read-only, so editing one writes a copy. */
const BUILTIN_PREFIX = 'builtin:';

export function createWhisperingRecipes({
	table,
}: {
	table: WhisperingData['tables']['recipes'];
}) {
	let rows = $state.raw<Recipe[]>([]);
	let nonconforming = $state.raw<NonconformingRow[]>([]);

	function read(): void {
		const listed = table;
		rows = listed.rows;
		nonconforming = listed.nonconforming;
	}

	read();
	const stop = table.subscribe(read);

	return {
		[Symbol.dispose]: stop,
		/** The shipped recipes and the person's own, in one list for the picker. */
		get pickable(): Recipe[] {
			return [
				...BUILTIN_RECIPES,
				...rows.toSorted((left, right) => left.name.localeCompare(right.name)),
			];
		},
		/** How many the person wrote. The built-in ones are not theirs. */
		get count(): number {
			return rows.length;
		},
		get nonconforming(): NonconformingRow[] {
			return nonconforming;
		},
		/** Save a recipe. A built-in one is copied rather than overwritten. */
		set({ id, ...fields }: Recipe): void {
			// A built-in is not a row, so saving one mints a copy the person owns.
			// So does an id this store has never seen, which is what a recipe
			// carried over from another device looks like before it syncs.
			const isRow =
				!id.startsWith(BUILTIN_PREFIX) && rows.some((row) => row.id === id);
			if (isRow) {
				const result = table.update(id, fields);
				if (result.error !== null) throw result.error;
			} else {
				table.create(fields);
			}
			read();
		},
		delete(id: string): void {
			if (id.startsWith(BUILTIN_PREFIX)) return;
			// Reports only whether a row was there to take; an already-gone recipe
			// is still truthfully deleted.
			table.delete(id);
			read();
		},
	};
}

export type WhisperingRecipes = ReturnType<typeof createWhisperingRecipes>;

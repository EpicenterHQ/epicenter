import type {
	NonconformingRowError,
	RecordTableLens,
	RowFor,
	TableDefinition,
} from '@epicenter/data/record';
import { createSubscriber } from 'svelte/reactivity';

export type ReadonlyTableView<TDefinition extends TableDefinition> = {
	readonly all: readonly RowFor<TDefinition>[];
	readonly nonconforming: readonly NonconformingRowError[];
	readonly loadError: unknown;
	readonly whenReady: Promise<void>;
	byId(id: string): RowFor<TDefinition> | undefined;
	refresh(): Promise<void>;
};

/** Create a reactive classified view over one bound Data table lens. */
export function fromTable<TDefinition extends TableDefinition>(
	table: Pick<RecordTableLens<TDefinition, never, never>, 'scan' | 'subscribe'>,
): ReadonlyTableView<TDefinition> {
	let rows = $state.raw<RowFor<TDefinition>[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		try {
			const { rows: nextRows, nonconforming: nextNonconforming } =
				await table.scan();
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	const subscribe = createSubscriber((update) =>
		table.subscribe(() => {
			void refresh().then(update, update);
		}),
	);
	const whenReady = refresh();

	return {
		get all() {
			subscribe();
			return rows;
		},
		get nonconforming() {
			subscribe();
			return nonconforming;
		},
		get loadError() {
			subscribe();
			return loadError;
		},
		whenReady,
		byId(id: string) {
			subscribe();
			return rows.find((row) => row.id === id);
		},
		refresh,
	};
}

/** Window-owned recipes and executions. Clean saved views read directly from the file. */
import type { SavedView, SavedViewChange } from '@epicenter/folder/declaration';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { QueryAnswer } from '../ui/bindings.gen';

export type TableView = Extract<SavedView, { type: 'grid' | 'board' }>;
export type ViewUpdater = (
	change: SavedViewChange,
) => Promise<{ error: { reason: string } | null }>;
export type Execution = {
	sql: string;
	running: boolean;
	answer?: QueryAnswer;
	error?: string;
};
type Publication = {
	key: string;
	base: SavedView | undefined;
	kind: 'new' | 'update';
};
type Working = {
	base: SavedView | undefined;
	value: SavedView;
	publication?: Publication;
	error?: string;
	notice?: string;
	dismissed?: boolean;
};
export const TABLES = 'scratch:tables';
export const SQL = 'scratch:sql';
export const savedKey = (key: string) => `saved:${key}`;
const scratch = (key: string) => key === TABLES || key === SQL;
const recordKey = (key: string) => key.slice('saved:'.length);

export function createViews({
	saved,
	update,
	exclusive,
	refreshed,
}: {
	saved: () => Record<string, SavedView>;
	update: ViewUpdater;
	exclusive: <T>(action: () => Promise<T>) => Promise<T>;
	refreshed: () => Promise<void>;
}) {
	const working = new SvelteMap<string, Working>([
		[
			TABLES,
			{ base: undefined, value: { type: 'grid', title: 'Tables', table: '*' } },
		],
		[
			SQL,
			{
				base: undefined,
				value: {
					type: 'sql',
					title: 'SQL',
					sql: "SELECT path, json_extract(fields, '$.title') AS title, body FROM documents",
				},
			},
		],
	]);
	const executions = new SvelteMap<string, Execution>();
	/** Explicit view commands stay pending through their display refresh, outside Folder close. */
	const pending = new SvelteSet<string>();
	function stored(key: string) {
		const records = saved();
		const id = recordKey(key);
		return key.startsWith('saved:') && Object.hasOwn(records, id)
			? records[id]
			: undefined;
	}
	function value(key: string) {
		return working.get(key)?.value ?? stored(key);
	}
	function edit(key: string, next: SavedView) {
		const before = working.get(key);
		working.set(key, {
			...before,
			base: before ? before.base : stored(key),
			value: next,
		});
	}
	function acknowledge(
		key: string,
		sent: SavedView,
		publication: Publication,
		notice?: string,
	) {
		const after = working.get(key);
		// A reload or earlier completion retired this publication. Later edits
		// at the same key belong to their own publication, not this copy.
		if (after?.publication !== publication) return key;
		const target = savedKey(publication.key);
		if (key !== target && working.has(target)) {
			// The copy became visible before every query finished refreshing.
			// Keep independently edited source and target settings separately.
			if (scratch(key))
				working.set(key, { base: undefined, value: after.value });
			else if (after.value === sent) working.delete(key);
			else working.set(key, { base: after.base, value: after.value });
			return target;
		}
		if (key !== target) {
			if (scratch(key)) working.set(key, { base: undefined, value: sent });
			else working.delete(key);
		}
		if (after.value === sent && notice === undefined) working.delete(target);
		else working.set(target, { base: sent, value: after.value, notice });
		return target;
	}

	async function save(key: string, asNew = false): Promise<string> {
		if (pending.has(key)) return key;
		const next = value(key);
		if (!next) return key;
		const before = working.get(key) ?? { base: stored(key), value: next };
		// Keep the submitted target across ambiguous failures and failed rereads.
		const kind =
			asNew || scratch(key) ? 'new' : (before.publication?.kind ?? 'update');
		const publication: Publication =
			before.publication?.kind === kind
				? before.publication
				: {
						key: kind === 'new' ? crypto.randomUUID() : recordKey(key),
						base: kind === 'new' ? undefined : before.base,
						kind,
					};
		const sent = { ...before, publication };
		working.set(key, sent);
		let committed = false;
		pending.add(key);
		try {
			await exclusive(async () => {
				const result = await update({
					key: publication.key,
					base: publication.base,
					value: sent.value,
				});
				if (result.error !== null) throw new Error(result.error.reason);
				committed = true;
			});
			await refreshed();
			return acknowledge(key, sent.value, publication);
		} catch (cause) {
			if (committed)
				return acknowledge(
					key,
					sent.value,
					publication,
					`The view was saved, but could not be read again: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			const after = working.get(key) ?? sent;
			working.set(key, {
				...after,
				error: cause instanceof Error ? cause.message : String(cause),
				dismissed: false,
			});
			return key;
		} finally {
			pending.delete(key);
		}
	}
	return {
		value,
		edit,
		busy: (key: string) => pending.has(key),
		save,
		get held() {
			return [...working]
				.filter(([key]) => !scratch(key))
				.map(([key, entry]) => [key, entry.value] as const);
		},
		dirty: (key: string) =>
			!scratch(key) &&
			working.has(key) &&
			working.get(key)!.value !== working.get(key)!.base,
		error: (key: string) => working.get(key)?.error,
		notice: (key: string) => working.get(key)?.notice,
		reload(key: string) {
			if (pending.has(key)) return;
			if (!scratch(key)) working.delete(key);
			else {
				const current = working.get(key);
				if (current)
					working.set(key, { base: undefined, value: current.value });
			}
		},
		dismiss(key: string) {
			const current = working.get(key);
			if (current) working.set(key, { ...current, dismissed: true });
		},
		get failed() {
			return [...working.values()].some(
				(entry) => entry.error && !entry.dismissed,
			);
		},
		async remove(key: string) {
			if (pending.has(key)) return false;
			pending.add(key);
			try {
				const before = working.get(key);
				const base = before ? before.base : stored(key);
				const displayed = value(key);
				try {
					await exclusive(async () => {
						const result = await update({
							key: recordKey(key),
							base,
							value: undefined,
						});
						if (result.error !== null) throw new Error(result.error.reason);
					});
				} catch (cause) {
					const after = working.get(key);
					if (displayed)
						working.set(key, {
							...after,
							base: after ? after.base : base,
							value: after?.value ?? displayed,
							error: cause instanceof Error ? cause.message : String(cause),
							dismissed: false,
						});
					return false;
				}
				// Keep any settings typed while the deletion was running.
				if (working.get(key) === before) working.delete(key);
				try {
					await refreshed();
				} catch {
					// The query reports its read error. The deletion already committed.
				}
				return true;
			} finally {
				pending.delete(key);
			}
		},
		execution: (key: string) => executions.get(key),
		async run(
			key: string,
			query: (sql: string) => Promise<{
				data: QueryAnswer | null;
				error: { message: string } | null;
			}>,
		) {
			const recipe = value(key);
			if (recipe?.type !== 'sql' || executions.get(key)?.running) return;
			const execution: Execution = { sql: recipe.sql, running: true };
			executions.set(key, execution);
			try {
				const result = await query(execution.sql);
				executions.set(key, {
					...execution,
					running: false,
					...(result.error !== null
						? { error: result.error.message }
						: { answer: result.data! }),
				});
			} catch (cause) {
				executions.set(key, {
					...execution,
					running: false,
					error: cause instanceof Error ? cause.message : String(cause),
				});
			}
		},
	};
}
export type Views = ReturnType<typeof createViews>;

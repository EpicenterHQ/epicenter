/** Explicit view forms and SQL executions; submitted text belongs to the file editor. */
import {
	changeSavedView,
	type SavedView,
	type SavedViewChange,
} from '@epicenter/folder/declaration';
import type { ReactiveDocument } from '@epicenter/svelte/document';
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok } from 'wellcrafted/result';
import type { QueryAnswer } from '../ui/bindings.gen';

export type TableView = Extract<SavedView, { type: 'grid' | 'board' }>;
export type Execution = {
	sql: string;
	running: boolean;
	answer?: QueryAnswer;
	error?: string;
};
export const TABLES = 'scratch:tables';
export const SQL = 'scratch:sql';
export const savedKey = (key: string) => `saved:${key}`;
const scratch = (key: string) => key === TABLES || key === SQL;
const recordKey = (key: string) => key.slice('saved:'.length);

export function createViews({
	saved,
	declaration,
}: {
	saved: () => Record<string, SavedView>;
	declaration: ReactiveDocument;
}) {
	/** Unsubmitted form values; successful admission retires them before I/O. */
	const forms = new SvelteMap<string, SavedView>([
		[TABLES, { type: 'grid', title: 'Tables', table: '*' }],
		[
			SQL,
			{
				type: 'sql',
				title: 'SQL',
				sql: "SELECT path, json_extract(fields, '$.title') AS title, body FROM documents",
			},
		],
	]);
	const problems = new SvelteMap<string, string>();
	const executions = new SvelteMap<string, Execution>();
	function stored(key: string) {
		const records = saved();
		const id = recordKey(key);
		return key.startsWith('saved:') && Object.hasOwn(records, id)
			? records[id]
			: undefined;
	}
	function value(key: string) {
		return forms.get(key) ?? stored(key);
	}
	/** No await separates the source read, replacement, and captured publication. */
	function publish(change: SavedViewChange) {
		const content = declaration.content;
		if (content === undefined && declaration.loadError?.name !== 'Missing')
			return Err({
				reason:
					declaration.loadError?.message ??
					'Reading epicenter.json; try again when it is available',
			});
		const changed = changeSavedView(content?.text ?? '{}', change);
		if (changed.error !== null) return changed;
		const replaced = declaration.replace(changed.data);
		if (replaced.error !== null) return Err({ reason: replaced.error.message });
		// The declaration owner retains the composed source and any save failure.
		void declaration.save();
		return Ok(undefined);
	}
	return {
		value,
		edit(key: string, next: SavedView) {
			forms.set(key, next);
			problems.delete(key);
		},
		/** Admission is synchronous; selection follows a new key before saving settles. */
		save(key: string, asNew = false) {
			const next = value(key);
			if (next === undefined) return key;
			const target =
				asNew || scratch(key) ? crypto.randomUUID() : recordKey(key);
			const result = publish({ key: target, value: next });
			if (result.error !== null) {
				problems.set(key, result.error.reason);
				return key;
			}
			if (!scratch(key)) forms.delete(key);
			problems.delete(key);
			return savedKey(target);
		},
		get held() {
			return [...forms].filter(([key]) => !scratch(key));
		},
		dirty: (key: string) => !scratch(key) && forms.has(key),
		error: (key: string) => problems.get(key),
		reload(key: string) {
			if (!scratch(key)) forms.delete(key);
			problems.delete(key);
		},
		remove(key: string) {
			const result = publish({ key: recordKey(key), value: undefined });
			if (result.error !== null) {
				problems.set(key, result.error.reason);
				return false;
			}
			forms.delete(key);
			problems.delete(key);
			return true;
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
						: { answer: result.data ?? undefined }),
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

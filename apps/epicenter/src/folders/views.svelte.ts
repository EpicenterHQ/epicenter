/** Explicit view forms and SQL executions; submitted text belongs to the file editor. */
import {
	changeSavedView,
	type SavedView,
	type SavedViewChange,
} from '@epicenter/folder/declaration';
import type { Saved } from '@epicenter/folder/next';
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
	declaration: {
		text(): string | undefined | null;
		write(text: string): Saved;
	};
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
	const submitted = new SvelteMap<string, SavedView>();
	const submittedText = new Map<string, string>();
	let sending: string | undefined;
	const executions = new SvelteMap<string, Execution>();
	function stored(key: string) {
		const records = saved();
		const id = recordKey(key);
		return key.startsWith('saved:') && Object.hasOwn(records, id)
			? records[id]
			: undefined;
	}
	function value(key: string) {
		return forms.get(key) ?? submitted.get(key) ?? stored(key);
	}
	/** No await separates the source read, replacement, and captured publication. */
	function publish(change: SavedViewChange, key: string) {
		const current = declaration.text();
		if (current === null)
			return Err({
				reason: 'epicenter.json cannot be read; open it to fix it',
			});
		const changed = changeSavedView(sending ?? current ?? '{}', change);
		if (changed.error !== null) return changed;
		const text = (sending = changed.data);
		if (change.value) {
			submitted.set(key, change.value);
			submittedText.set(key, text);
		}
		void declaration.write(text).then(({ error }) => {
			if (sending === text) sending = undefined;
			if (submittedText.get(key) !== text) return;
			submittedText.delete(key);
			submitted.delete(key);
			if (error !== null && change.value) {
				forms.set(key, change.value);
				problems.set(key, error.message);
			}
		});
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
			const result = publish({ key: target, value: next }, savedKey(target));
			if (result.error !== null) {
				problems.set(key, result.error.reason);
				return key;
			}
			if (!scratch(key)) forms.delete(key);
			problems.delete(key);
			return savedKey(target);
		},
		get held() {
			return [...new Map([...submitted, ...forms])].filter(
				([key]) => !scratch(key),
			);
		},
		dirty: (key: string) => !scratch(key) && forms.has(key),
		error: (key: string) => problems.get(key),
		reload(key: string) {
			if (!scratch(key)) forms.delete(key);
			problems.delete(key);
		},
		remove(key: string) {
			const result = publish({ key: recordKey(key), value: undefined }, key);
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

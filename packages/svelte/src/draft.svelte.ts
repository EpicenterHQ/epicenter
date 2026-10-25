/**
 * Input owned by one editor while its save runs.
 *
 * Typing appears immediately. A successful latest save releases the draft to
 * follow the landed source; a failed save keeps the typed value and its error
 * on screen. A later edit or `retry()` saves it again, and `discard()` follows
 * the source while ignoring any older answer still in flight.
 *
 * ```svelte
 * const title = draft(
 * 	() => todo?.fields?.title ?? '',
 * 	(value) => folder.tables.todos.update(id, { fields: { title: value } }),
 * );
 * <input bind:value={title.value} />
 * ```
 */
import type { Result } from 'wellcrafted/result';

export function draft<T, E>(
	source: () => T,
	save: (value: T) => Promise<Result<unknown, E>>,
) {
	let typed = $state<{ value: T } | null>(null);
	let error = $state<E | null>(null);
	let latest = 0;
	const set = (value: T) => {
		typed = { value };
		error = null;
		const mine = ++latest;
		void save(value).then((answer) => {
			if (mine !== latest) return;
			if (answer.error === null) typed = null;
			else error = answer.error;
		});
	};
	return {
		get value() {
			return typed === null ? source() : typed.value;
		},
		set value(value: T) {
			set(value);
		},
		get error() {
			return error;
		},
		set,
		retry() {
			if (typed !== null) set(typed.value);
		},
		discard() {
			latest++;
			typed = null;
			error = null;
		},
	};
}

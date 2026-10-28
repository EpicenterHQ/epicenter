/**
 * Svelte 5 reactivity over the repository API. Both adapters read through
 * `createSubscriber`: a read inside an effect or template subscribes, the
 * subscription lasts while something reads it, and a read anywhere else is a
 * snapshot.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import type { Live, OpenNote } from '../define.js';

/**
 * A live query as reactive state: `current` is its latest result, and
 * undefined until the first arrives.
 *
 *     const todos = live(repo.todos.live());
 *     {#each todos.current ?? [] as todo (todo.path)}
 */
export function live<T>(query: Live<T>) {
	let value: T | undefined;
	const track = createSubscriber((update) =>
		query.subscribe((next) => {
			value = next;
			update();
		}),
	);
	return {
		get current() {
			track();
			return value;
		},
	};
}

/**
 * An open note as reactive state: `current` re-renders on every change, its
 * own writes included, which show at once. The commands are the note's own.
 *
 *     const todo = opened(await repo.todos.open({ stem }));
 *     <input bind:value={() => todo.current?.fields.title ?? '', (title) => todo.set('title', title)} />
 */
export function opened<TPath extends string, TNoteSchema extends TSchema>(note: OpenNote<TPath, TNoteSchema>) {
	const track = createSubscriber((update) => note.subscribe(update));
	return {
		params: note.params,
		/** The note as this device shows it, or null when there is none. */
		get current() {
			track();
			return note.read();
		},
		write: note.write,
		set: note.set,
		append: note.append,
		delete: note.delete,
		close: note.close,
	};
}

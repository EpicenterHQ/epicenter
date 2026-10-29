/**
 * Svelte 5 reactivity over the repository API (`@epicenter/repository`).
 * `reactive(repo)` is the repository with the same methods, its reads
 * tracked: a collection's `all()` and `get()` re-run when that collection's
 * notes change, `status()` when the status does, and `revision()` after any
 * change (to any file, in a collection or none), so a `$derived` or `$effect` that reads it re-runs a SQL query or
 * a `read()`. Reads outside an effect or a template are plain snapshots.
 *
 *     const repo = reactive(openBrowserRepository({ app, replica }));
 *     const open = $derived(repo.todos.all().filter((todo) => !todo.fields.done));
 *     $effect(() => {
 *         repo.revision();
 *         void repo.query('SELECT stem FROM entries ORDER BY stem DESC LIMIT 20').then(show);
 *     });
 *
 * `tracked(editor)` is an editor's draft and state as reactive getters; a
 * CodeMirror view binds to the editor itself (`./codemirror.ts`).
 */
import type { Definitions, Editor, Repository, RepositoryChange } from '@epicenter/repository';
import { createSubscriber } from 'svelte/reactivity';

const isCollection = (value: unknown): value is Record<string, (...args: never[]) => unknown> => typeof value === 'object' && value !== null && 'create' in value;

/** The repository, its reads tracked per collection, its status and its revision. */
export function reactive<TRepository extends Repository<Definitions>>(repo: TRepository): TRepository {
	const tracker = (heard: (change: RepositoryChange) => boolean) =>
		createSubscriber((update) =>
			repo.subscribe((change) => {
				if (heard(change)) update();
			}),
		);
	const status = tracker((change) => change.status);
	// Every change: a status, a collection's notes, or any file at all, in a collection or none.
	const anything = tracker(() => true);
	const wrapped: Record<string, unknown> = {
		...repo,
		status() {
			status();
			return repo.status();
		},
		revision() {
			anything();
			return repo.revision();
		},
	};
	for (const [name, collection] of Object.entries(repo)) {
		if (!isCollection(collection) || !('all' in collection)) continue;
		const track = tracker((change) => change.status || change.collections.includes(name));
		const { all, get } = collection as unknown as { all(): unknown; get(params: unknown): unknown };
		wrapped[name] = {
			...collection,
			all() {
				track();
				return all();
			},
			get(params: unknown) {
				track();
				return get(params);
			},
		};
	}
	return wrapped as TRepository;
}

/** An editor's draft and state, tracked. */
export function tracked(editor: Editor) {
	const track = createSubscriber((update) => editor.subscribe(() => update()));
	return {
		editor,
		get draft() {
			track();
			return editor.draft();
		},
		get state() {
			track();
			return editor.state();
		},
	};
}

export { editorBinding, createEditorView } from './codemirror.js';

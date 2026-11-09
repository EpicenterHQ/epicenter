/**
 * An app's `src/lib/app.ts`, for the module-scope tests: the folder opened
 * and wrapped once, at module scope. Under the `test` condition
 * `home()` is a place in memory; `raw` is kept here only so a test can
 * write behind the adapter's back.
 */
import { defineContract } from '@epicenter/definition/contract';
import { home, openFolder } from '@epicenter/folder';
import { reactive } from '../reactive.js';

export const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

export const raw = openFolder(
	todos,
	home({ site: 'https://todos.epicenter.so' }),
);
export const folder = reactive(raw);

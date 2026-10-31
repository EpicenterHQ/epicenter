/**
 * Todos' contract: a todo is a Markdown note at `todos/{id}.md`, its title
 * and whether it is done in front matter, its notes in the body. Todos has
 * no settings, so it has no settings note.
 *
 * Its name makes the repository `<account>/todos` (decision 46). It is
 * published, unchanged, as `static/contract.json` (`bun run contract`
 * writes it), so `epicenter check <url>/contract.json <dir>` checks a clone.
 */
import { defineContract } from '@epicenter/definition/contract';

export const todos = defineContract({
	name: 'todos',
	description:
		'Todos: a Markdown note per todo, its title and done in front matter, its notes in the body.',
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: {
				title: { type: 'string' },
				done: { type: 'boolean' },
			},
			required: ['title', 'done'],
		},
	},
});

export type Todos = typeof todos;

import {
	defineAction,
	defineApp,
	defineCollection,
	field,
} from '@epicenter/app';

const tasks = defineCollection({
	path: 'tasks/{time}.md',
	description: 'task',
	fields: {
		title: field.text({ description: 'What to do, one line' }),
		done: field.boolean({ description: 'Whether it is done' }),
		due: field.date({
			optional: true,
			description: 'The day it is due, as 2026-11-10; absent when it has none',
		}),
	},
});

/** `add`: a title of several lines keeps its first line as the title. */
const add = defineAction({
	description:
		'Add a task to do: a new tasks/<time>.md, named by the time. A title of several lines keeps its first line as the title and the rest as notes',
	input: {
		title: field.text({ description: 'What to do' }),
		due: field.date({ optional: true, description: 'The day it is due' }),
		notes: field.text({ optional: true, description: 'Notes in Markdown' }),
	},
	positional: ['title'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ title, due, notes }) => {
		const [first = '', ...rest] = title.trim().split(/\r?\n/);
		const heading = first.trim();
		if (heading === '') throw new Error('A task needs a title');
		const body = [rest.join('\n').trim(), notes?.trim() ?? '']
			.filter((part) => part !== '')
			.join('\n\n');
		return tasks.add({
			title: heading,
			due,
			body: body === '' ? '' : `${body}\n`,
		});
	},
});

export default defineApp({
	description:
		'Things I mean to do: a note per task, its title, whether it is done, and when it is due; its notes in the body',
	collections: { tasks },
	// One collection: its verbs are the app's own, `tasks add` rather than `tasks tasks add`.
	actions: { ...tasks.actions(), add },
});

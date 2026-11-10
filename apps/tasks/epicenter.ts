import { defineApp, field, timeId } from '@epicenter/app';
import declaration from './epicenter.json';

export default defineApp(declaration, {
	actions: {
		add: {
			description:
				'Add a task to do: a new tasks/<id>.md, its id made from the time. A title of several lines keeps its first line as the title and the rest as notes',
			input: {
				title: field.text({ description: 'What to do' }),
				due: field.date({ optional: true, description: 'The day it is due' }),
				notes: field.text({ optional: true, description: 'Notes in Markdown' }),
			},
			positional: ['title'],
			annotations: { destructiveHint: false, openWorldHint: false },
			async run({ title, due, notes }, { folder }) {
				const [first = '', ...rest] = title.trim().split(/\r?\n/);
				const heading = first.trim();
				if (heading === '') throw new Error('A task needs a title');
				const body = [rest.join('\n').trim(), notes?.trim() ?? '']
					.filter((part) => part !== '')
					.join('\n\n');
				const id = timeId();
				const lines = [
					`title: ${JSON.stringify(heading)}`,
					'done: false',
					...(due === undefined ? [] : [`due: ${JSON.stringify(due)}`]),
				];
				await folder.write(
					`tasks/${id}.md`,
					`---\n${lines.join('\n')}\n---\n${body === '' ? '' : `${body}\n`}`,
				);
				return { id, title: heading, done: false, ...(due ? { due } : {}) };
			},
		},
	},
});

import {
	defineAction,
	defineApp,
	defineCollection,
	field,
	Ok,
} from '@epicenter/app';

const kinds = ['thought', 'quote', 'link'] as const;
const notes = defineCollection({
	path: 'data/notes/{time}.md',
	fields: {
		kind: field.select(kinds),
		source: field.text({
			optional: true,
			description: 'Where this came from: a person, book, or URL',
		}),
		project: field.text({
			optional: true,
			description: 'The piece of writing this might belong to',
		}),
	},
});

const add = defineAction({
	description: 'Save a thought, quote, or link for later writing',
	input: {
		body: field.text({
			pattern: '\\S',
			description: 'Text containing something other than whitespace',
		}),
		kind: field.select(kinds, { optional: true }),
		source: field.text({ optional: true }),
		project: field.text({ optional: true }),
	},
	annotations: { destructiveHint: false, openWorldHint: false },
	run: ({ body, kind = 'thought', source, project }) =>
		notes.add({ body, kind, source, project }),
});

const search = defineAction({
	description:
		'Find saved notes by their text, source, or project; returns their full text',
	input: {
		query: field.text({ optional: true }),
		project: field.text({ optional: true }),
	},
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async ({ query = '', project }) => {
		const found = [];
		const needle = query.toLowerCase();
		for (const row of (await notes.list()).reverse()) {
			const note = row.error === null ? row.data : row.error.record;
			if (note) {
				if (project !== undefined && note.project !== project) continue;
				const text = [note.body, note.source, note.project].join('\n');
				if (!text.toLowerCase().includes(needle)) continue;
			}
			found.push(row.error === null ? row.data : row.error);
		}
		return Ok(found);
	},
});

export default defineApp({
	description:
		'A writing inbox: save thoughts and sources, then find them when you write',
	collections: { notes },
	actions: { ...notes.actions(), add, search },
});

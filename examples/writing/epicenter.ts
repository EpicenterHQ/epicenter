import {
	defineAction,
	defineApp,
	defineCollection,
	field,
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
	positional: ['body'],
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
	positional: ['query'],
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async ({ query = '', project }) => {
		const found = [];
		for (const row of (await notes.list()).reverse()) {
			if (project !== undefined && row.project !== project) continue;
			const note = await notes.get(row);
			if (
				note &&
				[note.body, note.source, note.project]
					.join('\n')
					.toLowerCase()
					.includes(query.toLowerCase())
			)
				found.push(note);
		}
		return found;
	},
});

export default defineApp({
	description:
		'A writing inbox: save thoughts and sources, then find them when you write',
	collections: { notes },
	actions: { ...notes.actions(), add, search },
});

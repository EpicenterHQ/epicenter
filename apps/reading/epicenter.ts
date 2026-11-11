import {
	defineAction,
	defineApp,
	defineCollection,
	field,
	localDay,
} from '@epicenter/app';

/**
 * A book is a file named by its title. Where it stands comes from its days,
 * so nothing can disagree with them: no `started` is a book I mean to read,
 * `started` alone one I am reading, and `finished` one I have read.
 */
const books = defineCollection({
	path: 'data/books/{title}.md',
	description: 'book',
	fields: {
		author: field.text({ optional: true, description: 'Who wrote it' }),
		started: field.date({
			optional: true,
			description: 'The day I started it; absent while I only mean to read it',
		}),
		finished: field.date({
			optional: true,
			description: 'The day I finished it; absent until I have',
		}),
		rating: field.integer({
			optional: true,
			min: 1,
			max: 5,
			description: 'How much I liked it',
		}),
	},
});

const title = field.text({ description: 'The title, as on the cover: Dune' });

const start = defineAction({
	description:
		'Start reading a book today, adding data/books/<title>.md when it is not there. A book I am already reading keeps its day; one I finished starts again, its finished day cleared',
	input: { title, author: books.fields.author },
	positional: ['title'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ title, author }) => {
		const today = localDay();
		return books.update({ path: books.pathOf({ title }) }, (book) => ({
			...(author === undefined ? {} : { author }),
			...(book?.started === undefined || book.finished !== undefined
				? { started: today, finished: null }
				: {}),
		}));
	},
});

const finish = defineAction({
	description:
		'Finish a book today, with a rating from 1 to 5 if I give one, adding data/books/<title>.md when it is not there. A book already finished keeps its day',
	input: { title, rating: books.fields.rating },
	positional: ['title', 'rating'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ title, rating }) => {
		const today = localDay();
		return books.update({ path: books.pathOf({ title }) }, (book) => ({
			finished: book?.finished ?? today,
			...(rating === undefined ? {} : { rating }),
		}));
	},
});

export default defineApp({
	description:
		'Books I mean to read, am reading, and have read: a note per book, named by its title, with its author, the days I started and finished it, and my rating; my notes on it in the body',
	collections: { books },
	// One collection: its verbs are the app's own, `reading add Dune` rather than `reading books add Dune`.
	actions: { ...books.actions(), start, finish },
});

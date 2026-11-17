import { defineApp, defineAction, field, Ok } from '@epicenter/app';
import { defineDirectory, file, files, markdown } from './directory.prototype';

import { vaultActions, vaultPages, keyedPages } from './vault.prototype';
import { entriesActions } from './page-entries.prototype';
import { takes } from './takes.prototype';

const interviews = defineDirectory('data/interviews/{interview}', {
	notes: markdown('notes.md', { title: field.text() }),
	consent: file('consent.pdf'),
	recordings: files('recordings/*'),
});

const pages = defineDirectory('data/pages/{page}', {
	article: markdown('article.md', {
		title: field.text(),
		published: field.boolean(),
	}),
	images: files('*.png'),
});

const key = { interview: field.text() };
export default defineApp({
	description: 'Selected interview prototype',
	collections: {
		...vaultPages.collections,
		...keyedPages.collections,
		...interviews.collections,
		...pages.collections,
	},
	actions: {
		entries: entriesActions,
		vault: vaultActions,
		takes,
		pages: {
			list: defineAction({
				description: 'List pages',
				input: {},
				run: pages.list,
			}),
			write: defineAction({
				description: 'Create an article',
				input: {
					page: field.text(),
					title: field.text(),
					published: field.boolean(),
					body: field.text(),
				},
				run: ({ page, ...data }) => pages.at(page).article.add(data),
			}),
			image: defineAction({
				description: 'Keep a PNG next to the article',
				input: {
					page: field.text(),
					image: field.file({ accept: ['image/png'] }),
				},
				run: ({ page, image }) => pages.at(page).images.add(image),
			}),
			images: defineAction({
				description: 'List neighboring images',
				input: { page: field.text() },
				run: async ({ page }) => Ok(await pages.at(page).images.list()),
			}),
			rename: defineAction({
				description: 'Rename a page',
				input: { page: field.text(), to: field.text() },
				run: ({ page, to }) => pages.at(page).rename(to),
			}),
		},
		list: defineAction({
			description: 'List interview folders',
			input: {},
			run: interviews.list,
		}),
		inspect: defineAction({
			description: 'Read the selected interview',
			input: key,
			async run(key) {
				const selected = interviews.at(key.interview);
				const result = await selected.notes.get();
				if (result.error) return result;
				return Ok({
					recordings: await selected.recordings.list(),
					notes: result.data ?? null,
				});
			},
		}),
		record: defineAction({
			description: 'Add a recording',
			input: { ...key, audio: field.file({ accept: ['audio/*'] }) },
			run: ({ interview, audio }) =>
				interviews.at(interview).recordings.add(audio),
		}),
		consent: defineAction({
			description: 'Add consent',
			input: { ...key, pdf: field.file({ accept: ['application/pdf'] }) },
			run: ({ interview, pdf }) => interviews.at(interview).consent.add(pdf),
		}),
		write: defineAction({
			description: 'Create notes',
			input: { ...key, title: field.text(), body: field.text() },
			run: ({ interview, title, body }) =>
				interviews.at(interview).notes.add({ title, body }),
		}),
		correct: defineAction({
			description: 'Correct a quote',
			input: { ...key, old: field.text(), new: field.text() },
			run: ({ interview, old, new: replacement }) =>
				interviews.at(interview).notes.set({ old, new: replacement }),
		}),
		rename: defineAction({
			description: 'Rename a whole interview folder',
			input: { ...key, to: field.text() },
			run: ({ interview, to }) => interviews.at(interview).rename(to),
		}),
	},
});

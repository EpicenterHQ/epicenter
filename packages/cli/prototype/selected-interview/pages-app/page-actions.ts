// Actions select a page once; each later call names the file it touches.
import { defineAction, field, Ok } from '@epicenter/app';
import { pages } from './pages';

const page = field.text();

export const pageActions = {
	list: defineAction({
		description: 'List pages',
		input: {},
		annotations: { readOnlyHint: true },
		run: () => pages.list(),
	}),
	read: defineAction({
		description: "Read a page's article",
		input: { page },
		annotations: { readOnlyHint: true },
		run: async ({ page }) => Ok((await pages.at(page).article.get()) ?? null),
	}),
	videos: defineAction({
		description: "List a page's video cuts",
		input: { page },
		annotations: { readOnlyHint: true },
		run: ({ page }) => pages.at(page).videos.list(),
	}),
	// The declaration allows any cut; this action only ever edits the short one.
	revise: defineAction({
		description: 'Correct a passage in the short video script',
		input: { page, old: field.text(), new: field.text() },
		run: ({ page, old, new: replacement }) =>
			pages.at(page).videos.at('short').script.set({ old, new: replacement }),
	}),
	replace: defineAction({
		description: 'Replace a cut’s final export',
		input: {
			page,
			video: field.text(),
			upload: field.file({ accept: ['video/mp4'] }),
		},
		run: ({ page, video, upload }) =>
			pages.at(page).videos.at(video).final.replace(upload),
	}),
	review: defineAction({
		description: 'Read the title of a cut’s review, if it has one',
		input: { page, video: field.text() },
		annotations: { readOnlyHint: true },
		run: async ({ page, video }) => {
			const r = await pages.at(page).videos.at(video).review.get();
			return r.error ? r : Ok(r.data?.title ?? null);
		},
	}),
};

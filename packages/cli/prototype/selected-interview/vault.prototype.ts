// Vault keeps its existing YAML article. This app understands the script and the final export.
import { defineAction, field, Ok } from '@epicenter/app';
import { defineDirectory, file, markdown } from './directory.prototype';

const videoParts = {
	script: markdown('script.md'),
	final: file('final.mp4'),
	direction: defineDirectory('direction', {
		review: markdown('review.md', { title: field.text() }),
	}),
};
export const vaultPages = defineDirectory('data/vault-pages/{page}', {
	article: markdown('article.md'),
	shortVideo: defineDirectory('short-video', videoParts),
	longVideo: defineDirectory('long-video', videoParts),
});
export const keyedPages = defineDirectory('data/keyed-pages/{page}', {
	article: markdown('article.md'),
	videos: defineDirectory('videos/{video}', videoParts),
});
const pageKey = { page: field.text() };
export const vaultActions = {
	listvideos: defineAction({
		description: 'List video folders for a page',
		input: pageKey,
		run: (key) => keyedPages.at(key.page).videos.list(),
	}),
	editvideo: defineAction({
		description: 'Edit a selected video script',
		input: {
			...pageKey,
			video: field.text(),
			old: field.text(),
			new: field.text(),
		},
		run: ({ page, video, old, new: replacement }) =>
			keyedPages
				.at(page)
				.videos.at(video)
				.script.set({ old, new: replacement }),
	}),
	editlong: defineAction({
		description: 'Edit the fixed long video',
		input: { ...pageKey, old: field.text(), new: field.text() },
		run: ({ page, old, new: replacement }) =>
			vaultPages.at(page).longVideo.script.set({ old, new: replacement }),
	}),
	reviewvideo: defineAction({
		description: 'Read a selected video review',
		input: { ...pageKey, video: field.text() },
		run: async ({ page, video }) => {
			const r = await keyedPages
				.at(page)
				.videos.at(video)
				.direction.review.get();
			return r.error ? r : Ok(r.data?.title ?? null);
		},
	}),
	replacevideo: defineAction({
		description: 'Replace a selected video export',
		input: {
			...pageKey,
			video: field.text(),
			upload: field.file({ accept: ['video/mp4'] }),
		},
		run: ({ page, video, upload }) =>
			keyedPages.at(page).videos.at(video).final.replace(upload),
	}),
	edit: defineAction({
		description: 'Correct a script passage',
		input: { ...pageKey, old: field.text(), new: field.text() },
		run: ({ page, old, new: replacement }) => {
			return vaultPages
				.at(page)
				.shortVideo.script.set({ old, new: replacement });
		},
	}),
	replace: defineAction({
		description: 'Replace the existing final MP4',
		input: { ...pageKey, video: field.file({ accept: ['video/mp4'] }) },
		run: ({ page, video }) => {
			return vaultPages.at(page).shortVideo.final.replace(video);
		},
	}),
	review: defineAction({
		description: 'Read an optional direction review',
		input: pageKey,
		run: async (key) => {
			const result = await vaultPages
				.at(key.page)
				.shortVideo.direction.review.get();
			if (result.error) return result;
			return Ok(result.data?.title ?? null);
		},
	}),
};

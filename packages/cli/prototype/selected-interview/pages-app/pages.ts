// The layout, said once. Every immediate child directory of data/pages is a page.
import { field } from '@epicenter/app';
import { defineDirectory, file, markdown } from './directory.prototype';

export const pages = defineDirectory('data/pages/{page}', {
	article: markdown('article.md'),
	videos: defineDirectory('videos/{video}', {
		script: markdown('script.md'),
		final: file('final.mp4'),
		review: markdown('review.md', { title: field.text() }),
	}),
});

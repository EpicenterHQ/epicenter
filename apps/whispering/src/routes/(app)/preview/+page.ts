import { error } from '@sveltejs/kit';

/** The preview is a design tool for development; a release has no such page. */
export const load = () => {
	if (!import.meta.env.DEV) error(404, 'Not found');
};

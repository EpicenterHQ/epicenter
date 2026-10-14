/**
 * The browser leaf: a folder in this browser's OPFS. Opening writes nothing;
 * the first todo creates it. Its remote is its Git configuration, which
 * Connect sets: a GitHub repository, reached through the Epicenter relay as
 * the signed-in account, or in development the loopback demo remote through
 * the same-origin Vite proxy. Nothing native is imported here.
 */
import { openFolder } from '@epicenter/folder/browser';
import { auth } from '#platform/auth';
import { githubRelay, githubRepository } from '../account/connector.js';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Who records the versions this browser makes. */
const AUTHOR = { name: 'Todos', email: 'todos@epicenter.so' };

const relay = githubRelay(() => {
	const state = auth?.getState();
	return state?.status === 'signed-in' ? state.account : undefined;
});

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
		browser: {
			author: AUTHOR,
			// GitHub through the relay; the demo remote is same-origin.
			httpFetch: (input, init) => {
				const url =
					input instanceof Request
						? input.url
						: input instanceof URL
							? input.href
							: input;
				const repository = /^https:\/\/github\.com\/[^/]+\/[^/]+\.git/.exec(
					url,
				);
				return repository !== null &&
					githubRepository(repository[0]) !== undefined
					? relay(input, init)
					: fetch(input, init);
			},
		},
	});

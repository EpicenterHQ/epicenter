import { expect, test } from 'bun:test';
import { openRemote } from './remote.js';

const contract = { collections: { notes: { path: 'notes/{id}.md' } } } as const;

async function requestedUrl(
	location:
		| { site: string; repository?: `${string}/${string}` }
		| { site?: string; repository: `${string}/${string}` },
) {
	let requested = '';
	const account = {
		baseURL: 'http://localhost:8787',
		signal: new AbortController().signal,
		fetch(input: Request | string | URL) {
			requested = String(input);
			return Promise.resolve(Response.json({ files: [] }));
		},
	};
	await openRemote(contract, { account, ...location }).notes.list();
	return requested;
}

test('openRemote names an Epicenter repository from the site', async () => {
	expect(
		await requestedUrl({ site: 'https://whispering.epicenter.so' }),
	).toContain('/git/~/whispering.git/');
});

test('openRemote uses the full host for another owner', async () => {
	expect(
		await requestedUrl({ site: 'https://zhongwen.bradenwong.com' }),
	).toContain('/git/~/zhongwen.bradenwong.com.git/');
});

test('an explicit repository wins over the site', async () => {
	expect(
		await requestedUrl({
			site: 'https://whispering.epicenter.so',
			repository: '~/notes',
		}),
	).toContain('/git/~/notes.git/');
});

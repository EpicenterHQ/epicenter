/**
 * What an app's sign-in asks for, from what its `app.ts` composes
 * (ADR-0792): each capability given the account says what it needs when it
 * is made, so the app lists nothing.
 *
 * Key behaviors:
 * - An app that gives the account to `home` and to `hosted` asks for both
 *   the repository's audience and the API's, the API's first
 * - An app that gives it only to `home` asks for the folders alone
 */
import { afterEach, expect, test } from 'bun:test';
import { type AppAccount, connectAccount } from '@epicenter/account';
// The browser's `home`, not the `test` condition's leaf this suite resolves.
import { home } from '../../folder/src/home.js';
import { hosted } from './hosted.js';

const API = 'http://localhost:8787';
const SITE = 'https://todos.epicenter.so';

/** Where the page's sign-in sends it once `compose` gave the account out, as its query. */
async function signInFor(compose: (account: AppAccount) => void) {
	const saved = new Map<string, string>();
	const storage = {
		getItem: (key: string) => saved.get(key) ?? null,
		setItem: (key: string, value: string) => void saved.set(key, value),
		removeItem: (key: string) => void saved.delete(key),
	};
	let sent = '';
	const globals = {
		localStorage: storage,
		sessionStorage: storage,
		location: {
			href: 'http://localhost:5186/',
			origin: 'http://localhost:5186',
			search: '',
			assign: (url: string) => {
				sent = url;
			},
			replace() {},
		},
	};
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	const account = connectAccount({ clientId: 'so.epicenter.todos', api: API });
	compose(account);
	await account.startSignIn();
	account[Symbol.dispose]();
	const query = new URL(sent).searchParams;
	return { scope: query.get('scope'), resources: query.getAll('resource') };
}

afterEach(() => {
	for (const key of ['localStorage', 'sessionStorage', 'location'])
		Reflect.deleteProperty(globalThis, key);
});

test('an app composing home and hosted models asks for the folders and the API', async () => {
	const asked = await signInFor((account) => {
		home({ site: SITE, account });
		hosted(account);
	});
	expect(asked.resources).toEqual([API, `${API}/folders`]);
	expect(asked.scope?.split(' ')).toEqual(
		expect.arrayContaining(['ai', 'folders:read', 'folders:write']),
	);
});

test('an app composing only home asks for the folders alone', async () => {
	expect(
		await signInFor((account) => {
			home({ site: SITE, account });
		}),
	).toEqual({
		scope: 'openid folders:read folders:write',
		resources: [`${API}/folders`],
	});
});

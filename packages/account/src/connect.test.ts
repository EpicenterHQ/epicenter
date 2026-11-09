/**
 * `connectAccount`: each capability given the account says what it needs,
 * and the package chooses where the page runs.
 *
 * Key behaviors:
 * - In a browser, sign-in asks for the audiences and scopes of every need
 *   declared, the API's first when anything reaches it
 * - A need declared after the account was made is asked for at the next
 *   sign-in
 * - In a Tauri window every app signs in through the shell
 */
import { afterEach, expect, mock, test } from 'bun:test';

let inTauri = false;
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inTauri,
	invoke: async () => null,
	Channel: class {},
}));

const { connectAccount } = await import('./connect.js');
type AccountNeed = import('./connect.js').AccountNeed;

const API = 'http://localhost:8787';

/** This test's browser: its storage, and where the page was last sent. */
function browserPage() {
	const saved = new Map<string, string>();
	const storage = {
		getItem: (key: string) => saved.get(key) ?? null,
		setItem: (key: string, value: string) => void saved.set(key, value),
		removeItem: (key: string) => void saved.delete(key),
	};
	const sent = { url: '' };
	const globals = {
		localStorage: storage,
		sessionStorage: storage,
		location: {
			href: 'http://localhost:5186/',
			origin: 'http://localhost:5186',
			search: '',
			assign: (url: string) => {
				sent.url = url;
			},
			replace() {},
		},
	};
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	return sent;
}

/** Where a browser sign-in sends the page once `needs` were declared, as its query. */
async function authorization(needs: readonly AccountNeed[]) {
	const sent = browserPage();
	const account = connectAccount({ clientId: 'so.epicenter.todos', api: API });
	for (const need of needs) account.need(need);
	await account.startSignIn();
	account[Symbol.dispose]();
	const query = new URL(sent.url).searchParams;
	return { scope: query.get('scope'), resources: query.getAll('resource') };
}

afterEach(() => {
	inTauri = false;
	for (const key of ['localStorage', 'sessionStorage', 'location'])
		Reflect.deleteProperty(globalThis, key);
});

test('in a browser, the folders alone ask for their audience alone', async () => {
	expect(await authorization(['folders'])).toEqual({
		scope: 'openid folders:read folders:write',
		resources: [`${API}/folders`],
	});
});

test('in a browser, every need is asked for once, the API first', async () => {
	expect(await authorization(['folders', 'ai', 'profile', 'ai'])).toEqual({
		// Two audiences: the callback refreshes once for the second.
		scope: 'openid profile email ai folders:read folders:write offline_access',
		resources: [API, `${API}/folders`],
	});
});

test('a need declared after the account was made is asked for at the next sign-in', async () => {
	const sent = browserPage();
	const account = connectAccount({ clientId: 'so.epicenter.todos', api: API });
	account.need('folders');
	expect(account.state().status).toBe('signed-out');
	account.need('ai');
	await account.startSignIn();
	account[Symbol.dispose]();
	expect(new URL(sent.url).searchParams.getAll('resource')).toEqual([
		API,
		`${API}/folders`,
	]);
});

test('in a Tauri window every app signs in through the shell', () => {
	inTauri = true;
	const account = connectAccount({ clientId: 'so.epicenter.todos', api: API });
	account.need('folders');
	expect('completeSignIn' in account).toBe(false);
});

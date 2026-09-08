import { asPrincipalId } from '@epicenter/principal';
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { createGeneration, openDatabase } from '@epicenter/data/browser';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createEpicenter } from './index.js';

/**
 * What an application gets when it passes a definition and an account.
 *
 * These were `apps/honeycrisp/src/lib/databases.test.ts`, against the opener
 * that application wrote for itself. The opener is here now (ADR-0339), so the
 * coverage is too: a store opens and holds rows, a second boot reads them
 * offline, a refused credential costs sync and not the notes, a signed-out
 * account is refused without creating anything, two accounts on one device
 * hold two replicas, and a session erases the copy it was opened for.
 *
 * The other half is the serialization the tree cannot do for itself (ADR-0350).
 * Svelte creates a keyed child before it destroys the one it replaces, so the
 * new session's `open()` runs before the old session's `close()`, and every
 * test below that opens twice is written in that order deliberately.
 */

const APP_ID = 'so.epicenter.test';

const definition = defineData({
	id: 'so.epicenter.test',
	title: 'Test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
	},
});

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined);
}

async function resetStorage(): Promise<void> {
	for (const name of await databaseNames()) {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

function titles(data: {
	tables: { notes: { readonly rows: readonly { title: string }[] } };
}): string[] {
	return data.tables.notes.rows.map((row) => row.title).sort();
}

/**
 * The generations collection, in memory, per fake account.
 *
 * The one HTTP surface opening touches (ADR-0292): a POST that assigns a
 * number and a GET that hands the state back. Held per client, so two fake
 * accounts are two accounts.
 */
function createFakeGenerations() {
	const held = new Map<number, Uint8Array>();
	return {
		held,
		async fetch(input: Request | string | URL, init?: RequestInit) {
			const url = new URL(String(input instanceof Request ? input.url : input));
			const item = /\/generations\/(\d+)$/.exec(url.pathname);
			if (init?.method === 'POST') {
				const generation = held.size + 1;
				held.set(generation, new Uint8Array(init.body as ArrayBuffer));
				return Response.json({ generation, position: 1 });
			}
			if (item !== null) {
				const bytes = held.get(Number(item[1]));
				if (bytes === undefined) return new Response(null, { status: 404 });
				return new Response(bytes as unknown as BodyInit, {
					headers: { 'epicenter-log-position': '1' },
				});
			}
			return Response.json({ generations: [...held.keys()].sort() });
		},
	};
}

function createFakeAccount({
	principalId = 'principal-under-test',
	openWebSocket = () => Promise.reject(new Error('not connected')),
}: {
	status: 'signed-out' | 'signed-in' | 'reauth-required';
	principalId?: string;
	openWebSocket?: () => Promise<WebSocket>;
}): Account {
	const generations = createFakeGenerations();
	return Object.freeze({
		principalId: asPrincipalId(principalId),
		baseURL: 'https://api.test',
		fetch: generations.fetch,
		getProfile() {
			throw new Error('Not part of opening a store');
		},
		openWebSocket,
	});
}

/** Create an empty generation in this account, the way a first run does. */
async function importEmptyGeneration(account: Account): Promise<void> {
	const created = await createGeneration(definition, {
		appId: APP_ID,
		account: account,
	});
	if (created.error !== null) throw created.error;
}

function handleFor(_account: Account) {
	return createEpicenter({
		appId: APP_ID,
		definition,
	});
}

/**
 * One handle, opened, and the one thing that ends it.
 *
 * A test needs the release a session component's cleanup would otherwise
 * perform: the store an application holds cannot close itself (ADR-0340), and
 * the session holds all three things opening acquired.
 */
async function openedBy(account: Account) {
	const session = handleFor(account).open(account);
	const opened = await session.opened;
	if (opened.error !== null) throw opened.error;
	return { data: opened.data, close: () => session.close() };
}

test('the store opens as a replica of the account that was passed in', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const { data, close } = await openedBy(account);
	data.tables.notes.create({ title: 'a note' });
	expect(titles(data)).toEqual(['a note']);
	// The address is on the store, and the generation is the one the account
	// listed rather than a number anybody chose (ADR-0339, ADR-0340).
	expect(data.appId).toBe(APP_ID);
	expect(data.dataId).toBe(definition.id);
	expect(data.generation).toBe(1);
	expect(String(data.principalId)).toBe('alice');

	await close();
});

test('construction acquires nothing, and opening is what does', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	// Building the handle claims no Web Lock, opens no IndexedDB, and makes no
	// round trip, and there is no property whose READ would.
	const before = await databaseNames();
	const epicenter = handleFor(account);
	// Reading every member, which is what a spread or a devtools panel does.
	// None of them is a getter that opens.
	expect({ ...epicenter }.appId).toBe(APP_ID);
	expect(await databaseNames()).toEqual(before);

	// Another handle can still take the claim, because nobody has taken it.
	const other = await openedBy(account);
	await other.close();

	const session = epicenter.open(account);
	expect((await session.opened).error).toBeNull();
	await session.close();
});

test('a second handle is refused while the first one holds the address', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	if ((await session.opened).error !== null) throw new Error('did not open');

	// A second HANDLE is a second claim, and the store refuses it. That is the
	// dev-time shape of this: an application constructs one handle per document,
	// and hot-reloading the module that constructs it meets this until the first
	// one is closed.
	const other = await handleFor(account).open(account).opened;
	expect(other.error?.name).toBe('AlreadyOpen');

	await session.close();
});

test('opening while a session is held closes it first', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	// The account-switch order, which is Svelte's: the new keyed child calls
	// `open()` while the old one is still mounted, and only afterwards does the
	// old child's cleanup call `close()`. The handle serializes, so the second
	// session's real open runs after the first one's release, and it meets a
	// free address rather than `AlreadyOpen`.
	const epicenter = handleFor(account);
	const first = epicenter.open(account);
	const held = await first.opened;
	if (held.error !== null) throw held.error;
	held.data.tables.notes.create({ title: 'before the switch' });

	const second = epicenter.open(account);
	const reopened = await second.opened;
	if (reopened.error !== null) throw reopened.error;
	// A fresh open of the same address: a different store object over the same
	// durable record, not the one the first session was serving.
	expect(reopened.data).not.toBe(held.data);
	expect(titles(reopened.data)).toEqual(['before the switch']);

	// The old child's cleanup lands last, and it is a no-op: the handle already
	// closed this session, and the store the second one holds is untouched.
	await first.close();
	expect(titles(reopened.data)).toEqual(['before the switch']);

	await second.close();
});

test('opening while a close is in flight chains behind it', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const first = epicenter.open(account);
	if ((await first.opened).error !== null) throw new Error('did not open');

	// Not awaited: the close is still letting go of the Web Lock when the next
	// session asks for it. Starting a second open now would meet a conflict with
	// no other window in it.
	const closing = first.close();
	const second = epicenter.open(account);
	const opened = await second.opened;
	expect(opened.error).toBeNull();

	await closing;
	await second.close();
});

test('a session opens the address of the principal that was current at the call', async () => {
	await resetStorage();
	let account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const first = epicenter.open(account);
	const held = await first.opened;
	if (held.error !== null) throw held.error;
	held.data.tables.notes.create({ title: "alice's note" });

	// The switch: `open()` reads the state synchronously, so this session is
	// Alice's. The client signs in as Bob before the real open runs, which is
	// after the first session's close, and that must not move the address this
	// session already captured. A session answers for the principal that created
	// it.
	const second = epicenter.open(account);
	account = createFakeAccount({ status: 'signed-in', principalId: 'bob' });
	const reopened = await second.opened;
	if (reopened.error !== null) throw reopened.error;
	expect(String(reopened.data.principalId)).toBe('alice');
	expect(titles(reopened.data)).toEqual(["alice's note"]);

	await second.close();
});

test('a session closed while it is opening resolves SessionClosed', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	// The unmount-mid-open shape. The caller who awaited the open is TOLD,
	// rather than handed `Ok` over a store whose every verb throws.
	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	await session.close();
	expect((await session.opened).error?.name).toBe('SessionClosed');

	// And the claim it took is free, which is the whole point of awaiting the
	// close.
	const next = await openedBy(account);
	expect(titles(next.data)).toEqual([]);
	await next.close();
});

test('a session closed after it resolved keeps the value it resolved', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	const opened = await session.opened;
	if (opened.error !== null) throw opened.error;

	// `opened` is the outcome of THIS open, settled once. Closing ends what the
	// open acquired; it does not retract what the open answered, and a component
	// still rendering the resolved branch is not told a different story on its
	// way out.
	await session.close();
	const again = await session.opened;
	expect(again.error).toBeNull();
	expect(again.data).toBe(opened.data);
	// What the close ended is the store, which says so itself.
	expect(() => opened.data.tables.notes.rows).toThrow();
});

test('closing twice is closing once', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	if ((await session.opened).error !== null) throw new Error('did not open');

	// Not `Promise.all`, deliberately: awaiting only the SECOND close is the
	// case that used to resolve while the first was still letting go of the
	// lock. A caller that then opened met a conflict with no other window.
	const first = session.close();
	await session.close();
	const next = handleFor(account).open(account);
	expect((await next.opened).error).toBeNull();
	await next.close();
	await first;
});

test('the store a session hands over cannot end the session', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const session = handleFor(account).open(account);
	const opened = await session.opened;
	if (opened.error !== null) throw opened.error;

	// The lock, the socket, and the listener were acquired together and are
	// released together (ADR-0340). A store that could free one of the three
	// would leave a connection dialling against a dead document, so the store
	// carries no way to try: the session is what carries `close`.
	for (const verb of ['close', 'open', 'erase', 'dispose']) {
		expect(verb in opened.data).toBe(false);
	}
	expect(Symbol.dispose in opened.data).toBe(false);
	expect(Symbol.asyncDispose in opened.data).toBe(false);

	await session.close();
});

test('a failed open leaks nothing, and the next session is the retry', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	// The live failure a person meets: another context holds the document. It is
	// repaired by that context letting go, and the repair is a new session,
	// which is exactly what the retry button asks for.
	const holder = handleFor(account).open(account);
	if ((await holder.opened).error !== null) throw new Error('did not open');

	const epicenter = handleFor(account);
	const refused = epicenter.open(account);
	expect((await refused.opened).error?.name).toBe('AlreadyOpen');

	await holder.close();

	const retried = epicenter.open(account);
	expect((await retried.opened).error).toBeNull();
	await retried.close();
});

test('the handle closes the live session, which is the hot-reload path', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	// The module that built the handle is being replaced, and nothing in the
	// tree is going to unmount first. `epicenter.close()` is the one caller that
	// can end a session it does not hold a reference to.
	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	const opened = await session.opened;
	if (opened.error !== null) throw opened.error;

	await epicenter.close();
	expect(() => opened.data.tables.notes.rows).toThrow();

	// The replacement module opens fresh, which is what the release was for.
	const next = handleFor(account).open(account);
	expect((await next.opened).error).toBeNull();
	await next.close();

	// And a handle holding nothing closes without complaint.
	await epicenter.close();
});

test('a held copy opens from local storage before sync is available', async () => {
	await resetStorage();
	{
		const account = createFakeAccount({
			status: 'signed-in',
			principalId: 'alice',
		});
		await importEmptyGeneration(account);
		const { data, close } = await openedBy(account);
		data.tables.notes.create({ title: 'offline note' });
		await close();
	}

	const { data, close } = await openedBy(
		createFakeAccount({
			status: 'signed-in',
			principalId: 'alice',
			openWebSocket: () => Promise.reject(new Error('offline')),
		}),
	);
	expect(titles(data)).toEqual(['offline note']);
	await close();
});

test('a refused credential costs sync, not the notes', async () => {
	await resetStorage();
	const refusing = createFakeAccount({
		status: 'reauth-required',
		principalId: 'alice',
		openWebSocket: () =>
			Promise.reject({
				name: 'OpenWebSocketDenied',
				code: 'reauth-required',
			}),
	});
	await importEmptyGeneration(refusing);

	// The reversal ADR-0292 bought. A fresh replica used to be unavailable
	// until the authority stamped it; the store opens from local state before a
	// socket is attempted, so a refusal is a quiet status line and the notes
	// still read.
	const { data, close } = await openedBy(refusing);
	await Bun.sleep(1);
	expect(data.sync.status()?.refusal).toBe('reauth-required');

	// The notes half, and the whole of what "costs sync, not the notes" claims:
	// a store whose every dial is refused still takes a write and reads it back.
	data.tables.notes.create({ title: 'written while refused' });
	expect(titles(data)).toEqual(['written while refused']);
	await close();
});

test('two accounts on one device hold two replicas', async () => {
	await resetStorage();
	{
		const alice = createFakeAccount({
			status: 'signed-in',
			principalId: 'alice',
		});
		await importEmptyGeneration(alice);
		const { data, close } = await openedBy(alice);
		data.tables.notes.create({ title: "alice's note" });
		await close();
	}

	// Bob signs into the same machine. The principal is a segment of the
	// address, so cache-first resolution never hands him Alice's copy: he asks
	// his own account, mints his own generation, and opens it. There is no
	// refusal to render and nothing for a person to repair.
	const bob = createFakeAccount({ status: 'signed-in', principalId: 'bob' });
	await importEmptyGeneration(bob);
	const bobOpened = await openedBy(bob);
	expect(titles(bobOpened.data)).toEqual([]);
	bobOpened.data.tables.notes.create({ title: "bob's note" });
	await bobOpened.close();

	// And neither replica saw the other. Alice comes back to hers.
	const alice = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	const back = await openedBy(alice);
	expect(titles(back.data)).toEqual(["alice's note"]);
	await back.close();

	// Alice forgets this device. Bob's copy is untouched, because an erase
	// reaches only the principal the session was opened for.
	const erased = await handleFor(alice).open(alice).erase();
	expect(erased.error).toBeNull();
	const remaining = await databaseNames();
	expect(remaining.some((name) => name.includes('/bob/'))).toBe(true);
	expect(remaining.some((name) => name.includes('/alice/'))).toBe(false);
});

test('a session erases the copy it was opened for, closing itself first', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	const opened = await session.opened;
	if (opened.error !== null) throw opened.error;

	// The live path: a person invokes this from an account surface while their
	// data is open. Erasing takes the Web Lock this session is holding, and the
	// session is the one thing that can let it go, so the verb closes rather
	// than refusing itself with `AlreadyOpen`.
	const erased = await session.erase();
	expect(erased.error).toBeNull();
	expect(() => opened.data.tables.notes.rows).toThrow();
	expect(await databaseNames()).toEqual([]);

	// The handle holds nothing afterwards, which is what lets the component's
	// reopen take the address straight back rather than queue behind a session
	// that is gone.
	const next = epicenter.open(account);
	expect((await next.opened).error).toBeNull();
	await next.close();
});

test('an erase that fails leaves the copy, and the next session opens it', async () => {
	await resetStorage();
	const account = createFakeAccount({
		status: 'signed-in',
		principalId: 'alice',
	});
	// Two generations, so one can be held open by something this handle does not
	// own. Erasing claims every generation under the prefix before deleting any,
	// so a second window on the older one refuses the whole erase (ADR-0281).
	await importEmptyGeneration(account);
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const session = epicenter.open(account);
	if ((await session.opened).error !== null) throw new Error('did not open');

	const other = await openDatabase(definition, {
		appId: APP_ID,
		generation: 1,
		account: account,
	});
	if (other.error !== null) throw other.error;

	// Closing is what the deletion needs, not the deletion. The session ends
	// either way, and the copy is still there: reopening is the component's
	// move, and it is the same call the retry button makes.
	const refused = await session.erase();
	expect(refused.error?.name).toBe('AlreadyOpen');
	expect(await databaseNames()).not.toEqual([]);

	const reopened = epicenter.open(account);
	expect((await reopened.opened).error).toBeNull();

	await other.data.close();
	await reopened.close();
});

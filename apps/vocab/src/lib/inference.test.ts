/**
 * Vocab inference source tests.
 * The source opener runs with injected openers, so nothing is opened: no
 * account, no storage, no network.
 *
 * Key behaviors:
 * - The connections a learner saved come from one device catalog, opened the
 *   same way signed out and signed in, so signing in hides none of them
 * - Signing in adds hosted inference beside them and nothing else
 * - A hosted or catalog failure is reported and leaves the other usable
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/account';
import { openVocabInference } from './inference.js';

type Openers = NonNullable<Parameters<typeof openVocabInference>[1]>;

const account = {
	authorityId: 'authority',
	principalId: 'principal',
} as Account;

/** Openers that record how they were called and return recognizable values. */
function setup() {
	const calls: { hosted: unknown[][]; connections: unknown[][] } = {
		hosted: [],
		connections: [],
	};
	const hosted = { identity: account } as unknown as Awaited<
		ReturnType<Openers['hosted']>
	>;
	const catalog = { name: 'device catalog' } as unknown as Awaited<
		ReturnType<Openers['connections']>
	>;
	const open: Openers = {
		hosted: async (...args) => {
			calls.hosted.push(args);
			return hosted;
		},
		connections: async (...args: unknown[]) => {
			calls.connections.push(args);
			return catalog;
		},
	};
	return { calls, hosted, catalog, open };
}

test('signed out, the device catalog is the only source and hosted inference is not opened', async () => {
	const { calls, catalog, open } = setup();
	const sources = await openVocabInference(undefined, open);
	expect(sources.connections).toBe(catalog);
	expect(sources.account).toBeNull();
	expect(sources.errors).toEqual([]);
	expect(calls.hosted).toEqual([]);
});

test('signing in opens the same device catalog, with no account, and adds hosted inference', async () => {
	const { calls, hosted, catalog, open } = setup();
	const signedOut = await openVocabInference(undefined, open);
	const signedIn = await openVocabInference(account, open);

	expect(signedIn.connections).toBe(signedOut.connections);
	expect(signedIn.connections).toBe(catalog);
	// The catalog opener is given nothing either time: no account selects it.
	expect(calls.connections).toEqual([[], []]);
	expect(signedIn.account).toBe(hosted);
	expect(calls.hosted).toEqual([[{ account }]]);
});

test('a hosted failure leaves the device catalog usable, and a catalog failure leaves hosted usable', async () => {
	const { hosted, catalog, open } = setup();
	const noHosted = await openVocabInference(account, {
		...open,
		hosted: async () => {
			throw new Error('hosted is down');
		},
	});
	expect(noHosted.connections).toBe(catalog);
	expect(noHosted.account).toBeNull();
	expect(noHosted.errors).toEqual(['hosted is down']);

	const noCatalog = await openVocabInference(account, {
		...open,
		connections: async () => {
			throw new Error('storage is blocked');
		},
	});
	expect(noCatalog.account).toBe(hosted);
	expect(noCatalog.connections).toBeNull();
	expect(noCatalog.errors).toEqual(['storage is blocked']);
});

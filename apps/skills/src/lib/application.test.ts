/**
 * Skills opens its Account's current Personal library through App.
 * Instructions survive an offline reopen, and aborted boot releases ownership.
 * Rune shims permit imperative state reads; these tests do not prove reactivity.
 */
import 'fake-indexeddb/auto';
import { afterAll, expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { skillsDefinition } from '@epicenter/skills';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { openSkillsRuntime } from './application.js';

installTestLocks();
const previous = ['window', '$state', '$derived'].map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: Object.assign(new EventTarget(), {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	}),
});
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);
afterAll(() => {
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function accountFor(): Account {
	return {
		baseURL: 'https://skills.test',
		authorityId: 'test-authority',
		principalId: asPrincipalId(crypto.randomUUID()),
		supportsShared: false,
		async fetch(_input, init) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				},
				tail: [],
			});
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				close() {},
				send() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('The test never requests a profile');
		},
	};
}

test('the runtime opens the captured account current Personal library', async () => {
	const account = accountFor();
	await using runtime = await openSkillsRuntime({ account });
	expect(runtime.state.skills).toEqual([]);
	expect(runtime.data.library).toBe('personal');
	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toContain(
		`epicenter/${skillsDefinition.id}/accounts/${account.authorityId}/${account.principalId}/data/${skillsDefinition.id}/personal/current`,
	);
});

test('a skill and its instructions survive an offline reopen', async () => {
	const account = accountFor();
	let skillId: string;
	{
		await using runtime = await openSkillsRuntime({ account });
		skillId = runtime.state.createSkill('writing-voice');
		const held = runtime.data.tables.skills.get(skillId);
		if (held === undefined) throw new Error('The created row is absent');
		held.content.applyDelta(
			held.content.change.insert('Write directly.') as never,
		);
		await runtime.data.persistence.flush();
		expect(runtime.data.persistence.get()).toBe('saved');
	}
	account.fetch = async () => {
		throw new Error('Offline');
	};
	await using reopened = await openSkillsRuntime({ account });
	expect(reopened.state.skills.map(({ name }) => name)).toEqual([
		'writing-voice',
	]);
	expect(reopened.data.tables.skills.get(skillId)?.content.toString()).toBe(
		'Write directly.',
	);
});

test('an already aborted boot acquires no storage', async () => {
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));
	const before = await indexedDB.databases();
	await expect(
		openSkillsRuntime({ account: accountFor(), signal: controller.signal }),
	).rejects.toThrow('root unmounted');
	expect(await indexedDB.databases()).toEqual(before);
});

test('aborting during bootstrap closes the App before another opening', async () => {
	const account = accountFor();
	const fetch = account.fetch;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	account.fetch = async (...args) => {
		entered.resolve();
		await release.promise;
		return fetch(...args);
	};
	const controller = new AbortController();
	const opening = openSkillsRuntime({ account, signal: controller.signal });
	await entered.promise;
	controller.abort(new Error('root unmounted'));
	release.resolve();
	await expect(opening).rejects.toThrow('root unmounted');
	await using retry = await openSkillsRuntime({ account });
	expect(retry.data.tables.skills.rows).toHaveLength(0);
});

test('disposing retires retained data handles and repeated disposal joins closure', async () => {
	const account = accountFor();
	const runtime = await openSkillsRuntime({ account });
	const read = runtime.data.tables.skills.get;
	await Promise.all([
		runtime[Symbol.asyncDispose](),
		runtime[Symbol.asyncDispose](),
	]);
	expect(() => read('retained')).toThrow('disposed');
	await using retry = await openSkillsRuntime({ account });
	expect(retry.data.tables.skills.rows).toHaveLength(0);
});

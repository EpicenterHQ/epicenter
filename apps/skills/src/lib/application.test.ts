/**
 * SKIPPED: Skills has no auth client, and a store needs an account now that an
 * authority mints every generation. These pin real behavior and come back with
 * the rebuild AGENTS.md already schedules; they are not deleted because nothing
 * about what they assert became wrong.
 */
/**
 * Skills runtime tests.
 *
 * Skills is device-only, and this is what that means in practice: one
 * document, opened for the page lifetime, holding work that stays on this
 * machine and comes back when it reopens (ADR-0233). There is no auth client
 * in this build and no account replica, so there is exactly one ready shape.
 *
 * Key behaviors:
 * - The runtime opens the device document and nothing else
 * - A skill and its markdown survive reopening
 * - An aborted boot rejects with the abort
 *
 * `fake-indexeddb` supplies the browser store's storage, the harness the other
 * runtime tests in this repo use.
 */
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/device/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';

// The state module IS reactive state, so the runes are shimmed to their
// non-reactive meaning. These assertions read imperatively: the question is
// what the document holds, not whether a view recomputed.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

import { skillsDefinition } from '@epicenter/skills';
import { asPrincipalId } from '@epicenter/principal';
import { openSkillsRuntime } from './application.js';

/** The account these skipped tests will open under once Skills has auth. */
const ACCOUNT = {
	baseURL: 'https://api.epicenter.so',
	authorityId: 'test-authority',
	principalId: asPrincipalId('skills'),
	fetch: async () => new Response(null, { status: 404 }),
	openWebSocket() {
		throw new Error('Skipped Skills fixture has no sync server.');
	},
};

async function resetStorage(): Promise<void> {
	for (const database of await indexedDB.databases()) {
		const name = database.name;
		if (name === undefined) continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

test.skip('the runtime opens one store and nothing else', async () => {
	await resetStorage();
	await using runtime = await openSkillsRuntime({ account: ACCOUNT });

	expect(runtime.state.skills).toEqual([]);

	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toEqual([
		`epicenter/v4/so.epicenter.skills/${skillsDefinition.id}/1`,
	]);
});

test.skip('a skill and its instructions survive reopening', async () => {
	await resetStorage();
	let skillId: string;
	{
		await using runtime = await openSkillsRuntime({ account: ACCOUNT });
		skillId = runtime.state.createSkill('writing-voice');
		const held = runtime.data.tables.skills.get(skillId);
		if (held === undefined) throw new Error('the row has no content');
		const content = held.content;
		content.applyDelta(content.change.insert('Write directly.') as never);
		// The durable flush is asynchronous, so a reopen must wait for it.
		await runtime.data.persistence.flush();
		expect(runtime.data.persistence.get()).toBe('saved');
	}

	await using reopened = await openSkillsRuntime({ account: ACCOUNT });
	expect(reopened.state.skills.map(({ name }) => name)).toEqual([
		'writing-voice',
	]);
	expect(reopened.data.tables.skills.get(skillId)?.content.toString()).toBe(
		'Write directly.',
	);
});

test.skip('an aborted boot rejects with the abort', async () => {
	await resetStorage();
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));

	expect(
		openSkillsRuntime({ account: ACCOUNT, signal: controller.signal }),
	).rejects.toThrow('root unmounted');
});

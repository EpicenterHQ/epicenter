/**
 * Vocab's chat view starts a new opening once. After a failed opening,
 * switching to another chat and back remounts the keyed conversation without
 * silently retrying the tutor.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';
import { custom, type ModelChoices, openAi } from '@epicenter/ai';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { click } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

mock.module('$app/paths', () => ({ base: '' }));
HTMLElement.prototype.scrollTo ??= () => {};

const { openVocabFolder, until } = await import(
	'../../lib/vocab.test-support.js'
);
const { createEntries } = await import('../../lib/entries.svelte.js');
const { startChat } = await import('../../lib/chat/chats.js');
const { reactive } = await import('@epicenter/svelte/reactive');
const { flushSync, mount, unmount } = await import('svelte');

test('switching away and back does not ask for an opening again', async () => {
	using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expectOk(await entries.add('lucid'));
	let requests = 0;
	const ai = reactive(
		openAi([
			custom({
				id: 'tutor',
				baseUrl: 'https://tutor.test/v1',
				models: ['test-model'],
				fetch: async () => {
					requests++;
					return Response.json(
						{ error: { message: 'Tutor unavailable' } },
						{ status: 500 },
					);
				},
			}),
		]),
	);
	const choice = { endpoint: 'tutor', model: 'test-model' };
	const choices: ModelChoices<'chat'> = {
		get: () => choice,
		require: () => Ok(choice),
		problem: () => null,
		set: async () => {},
		subscribe: () => () => {},
	};
	mock.module(new URL('../../lib/app.ts', import.meta.url).pathname, () => ({
		folder: folder.lists,
		ai,
		choices,
		account: {
			state: () => ({ status: 'signed-out' }),
			accountManagementUrl: undefined,
		},
		profile: { read: async () => Ok({ email: '' }) },
	}));
	const { default: VocabAppHost } = await import(
		'./fixtures/VocabAppHost.svelte'
	);
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(VocabAppHost, { target, props: {} });
	flushSync();
	const choose = target.querySelector<HTMLButtonElement>(
		'[aria-label="Choose lucid for chat"]',
	);
	if (!choose) throw new Error('Word selection missing');
	choose.click();
	flushSync();
	click(target, 'Start chat');
	await until(
		() =>
			requests === 1 &&
			target.textContent?.includes('Tutor unavailable') === true,
	);
	expect(folder.files.paths('messages')).toEqual([]);
	const input = () =>
		target.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Message input"]',
		);
	const firstInput = input();
	if (!firstInput) throw new Error('First conversation view missing');
	expectOk(
		await startChat(folder.lists.chats, [{ entryId: 'other', text: 'other' }]),
	);
	flushSync();
	const history = target.querySelector('aside[aria-label="Chat history"]');
	if (!history) throw new Error('Chat history missing');
	click(history, 'other');
	flushSync();
	const otherInput = input();
	expect(otherInput).not.toBe(firstInput);
	click(history, 'lucid');
	flushSync();
	await Bun.sleep(0);
	flushSync();
	expect(input()).not.toBe(otherInput);
	expect(requests).toBe(1);
	expect(folder.files.paths('messages')).toEqual([]);
	expect(target.textContent).toContain('Retry opening');
	await unmount(view);
	target.remove();
});

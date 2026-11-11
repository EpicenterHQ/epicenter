/**
 * Messages actions preserve drafts, claim one send, and require a person's
 * resolution after uncertainty or interruption. Refusals preserve file bytes.
 */
import { expect, test } from 'bun:test';
import { createMemoryContext, inRun, readMarkdown } from '@epicenter/app';
import { DEMO_STATE } from './beeper.ts';
import app from './epicenter.ts';

const { draft, read, conversations, send, resolve } = app.actions;
const chat = 'maya-chen';
const setup = (files: Record<string, string> = {}) => {
	const context = createMemoryContext(files);
	return { context, run: <T>(work: () => T) => inRun(context, work) };
};
async function sent(context: ReturnType<typeof createMemoryContext>) {
	const state: { messages: { chat: string; text: string }[] } = JSON.parse(
		(await context.folder.read(DEMO_STATE)) ?? '{"messages":[]}',
	);
	return state.messages;
}

test('a fresh context reads the saved draft and refuses a stale previous value', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'See you at ten' }));
	const restarted = setup(await snapshot(context));
	expect((await restarted.run(() => read({ chat }))).draft).toBe(
		'See you at ten',
	);
	await expect(
		restarted.run(() => draft({ chat, text: 'Stale reply', previous: '' })),
	).rejects.toMatchObject({ name: 'Changed' });
	expect((await restarted.run(() => read({ chat }))).draft).toBe(
		'See you at ten',
	);
	expect(
		readMarkdown(
			(await restarted.context.folder.read('drafts/maya-chen.md')) ?? '',
		).body,
	).toBe('See you at ten\n');
});

test('clearing a draft leaves no list draft and clearing an absent draft writes nothing', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: '' }));
	expect(await context.folder.list()).toEqual([]);
	await run(() => draft({ chat, text: 'Hello' }));
	await run(() => draft({ chat, text: '', previous: 'Hello' }));
	expect(
		(await run(() => conversations({}))).find((row) => row.chat === chat),
	).not.toHaveProperty('draft');
});

test('sending consumes the saved draft once and a blind retry sends nothing', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'See you at ten' }));
	const result = await run(() => send({ chat }));
	expect(result.outcome).toBe('sent');
	expect(result.send).toMatchObject({
		state: 'sent',
		text: 'See you at ten',
		needsCheck: false,
	});
	expect(await sent(context)).toHaveLength(1);
	expect((await run(() => read({ chat }))).draft).toBe('');
	expect(
		readMarkdown((await context.folder.read('sends/maya-chen.md'))!).fields
			.state,
	).toBe('sent');
	await expect(run(() => send({ chat }))).rejects.toMatchObject({
		name: 'Refused',
	});
	expect(await sent(context)).toHaveLength(1);
});

test('two concurrent sends reach the provider exactly once', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'One reply' }));
	const results = await Promise.allSettled([
		run(() => send({ chat })),
		run(() => send({ chat })),
	]);
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
		1,
	);
	expect(await sent(context)).toHaveLength(1);
});

test('an unconfirmed send blocks another send across restart until a person resolves it', async () => {
	const chat = 'harbor-ferry';
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'Is there room for a bicycle?' }));
	expect(await run(() => send({ chat }))).toMatchObject({
		outcome: 'unconfirmed',
		send: { state: 'unconfirmed', needsCheck: true },
		next: expect.stringContaining(
			'epicenter messages resolve harbor-ferry sent|not-sent --attempt ',
		),
	});
	const first = (await run(() => read({ chat }))).send!;
	expect(first).toMatchObject({ state: 'unconfirmed', needsCheck: true });
	expect(await sent(context)).toHaveLength(1);
	await run(() => draft({ chat, text: 'A different reply' }));
	await expect(run(() => send({ chat }))).rejects.toMatchObject({
		name: 'Refused',
	});
	expect(await sent(context)).toHaveLength(1);
	const files: Record<string, string> = {};
	for (const path of await context.folder.list())
		files[path] = (await context.folder.read(path))!;
	const restarted = setup(files);
	await expect(restarted.run(() => send({ chat }))).rejects.toMatchObject({
		name: 'Refused',
	});
	await expect(
		restarted.run(() =>
			resolve({ chat, attempt: 'wrong', outcome: 'not-sent' }),
		),
	).rejects.toMatchObject({ name: 'Refused' });
	// Restoring a send must preserve a newer draft.
	expect(
		(
			await restarted.run(() =>
				resolve({ chat, attempt: first.attempt, outcome: 'not-sent' }),
			)
		).draft,
	).toBe('A different reply');
	expect(
		await restarted.run(() =>
			resolve({ chat, attempt: first.attempt, outcome: 'not-sent' }),
		),
	).toMatchObject({ send: { state: 'not-sent' } });
	await expect(
		restarted.run(() =>
			resolve({ chat, attempt: first.attempt, outcome: 'sent' }),
		),
	).rejects.toMatchObject({ name: 'Refused' });
	expect(await restarted.run(() => send({ chat }))).toMatchObject({
		outcome: 'unconfirmed',
	});
	expect(await sent(restarted.context)).toHaveLength(2);
	const second = (await restarted.run(() => read({ chat }))).send!;
	expect(
		(
			await restarted.run(() =>
				resolve({ chat, attempt: second.attempt, outcome: 'not-sent' }),
			)
		).draft,
	).toBe('A different reply');
	expect(await restarted.run(() => send({ chat }))).toMatchObject({
		outcome: 'unconfirmed',
	});
	const third = (await restarted.run(() => read({ chat }))).send!;
	const resolved = await restarted.run(() =>
		resolve({ chat, attempt: third.attempt, outcome: 'sent' }),
	);
	expect(resolved).toMatchObject({
		draft: '',
		send: { state: 'sent', needsCheck: false },
	});
	expect(
		await restarted.run(() =>
			resolve({ chat, attempt: third.attempt, outcome: 'sent' }),
		),
	).toEqual(resolved);
	expect(await sent(restarted.context)).toHaveLength(3);
});

async function snapshot(context: ReturnType<typeof createMemoryContext>) {
	const files: Record<string, string> = {};
	for (const path of await context.folder.list())
		files[path] = (await context.folder.read(path))!;
	return files;
}

test('death after consuming the draft leaves a blocking claim across restart', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'Hello' }));
	let reachedProvider!: () => void;
	const providerStarted = new Promise<void>((resolve) => {
		reachedProvider = resolve;
	});
	const update = context.folder.update;
	context.folder.update = (path, revise) => {
		if (path === DEMO_STATE) {
			reachedProvider();
			return new Promise<string>(() => {});
		}
		return update(path, revise);
	};
	void run(() => send({ chat }));
	await providerStarted;
	expect(await context.folder.read('sends/maya-chen.md')).toContain(
		'state: "sending"',
	);
	const restarted = setup(await snapshot(context));
	const current = await restarted.run(() => read({ chat }));
	expect(current).toMatchObject({
		draft: '',
		send: { state: 'sending', needsCheck: false },
	});
	// Even with a new draft, the interrupted claim blocks the provider.
	await restarted.run(() => draft({ chat, text: 'Another reply' }));
	const before = await snapshot(restarted.context);
	await expect(restarted.run(() => send({ chat }))).rejects.toMatchObject({
		name: 'Refused',
	});
	expect(await snapshot(restarted.context)).toEqual(before);
	expect(await sent(restarted.context)).toHaveLength(0);
	const attempt = current.send!.attempt;
	await expect(
		restarted.run(() => resolve({ chat, attempt, outcome: 'not-sent' })),
	).rejects.toMatchObject({
		name: 'Refused',
		message: expect.stringContaining('still being sent'),
	});
	expect(await snapshot(restarted.context)).toEqual(before);
	await restarted.run(() => draft({ chat, text: '' }));
	await restarted.context.folder.update('sends/maya-chen.md', (text) =>
		text!.replace(
			current.send!.at,
			new Date(Date.now() - 31_000).toISOString(),
		),
	);
	expect(
		await restarted.run(() => resolve({ chat, attempt, outcome: 'not-sent' })),
	).toMatchObject({
		draft: 'Hello',
		send: { state: 'not-sent', needsCheck: false },
	});
	expect(await sent(restarted.context)).toHaveLength(0);
});

test('send refuses a changed draft without claiming a send or reaching the provider', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'New reply' }));
	await expect(
		run(() => send({ chat, text: 'Old reply' })),
	).rejects.toMatchObject({ name: 'Changed' });
	expect(await sent(context)).toHaveLength(0);
	expect(await context.folder.read('sends/maya-chen.md')).toBeUndefined();
});

test('a draft changed after a new claim is preserved and the claim is removed', async () => {
	const { context, run } = setup();
	await run(() => draft({ chat, text: 'Original reply' }));
	const update = context.folder.update;
	let changed = false;
	context.folder.update = async (path, revise) => {
		if (path === 'drafts/maya-chen.md' && !changed) {
			changed = true;
			await context.folder.write(path, 'Newer reply\n');
		}
		return update(path, revise);
	};
	await expect(run(() => send({ chat }))).rejects.toMatchObject({
		name: 'Changed',
	});
	expect(await sent(context)).toHaveLength(0);
	expect(await run(() => read({ chat }))).toMatchObject({
		draft: 'Newer reply',
	});
	expect(await context.folder.read('sends/maya-chen.md')).toBeUndefined();
});

test('unknown conversations and missing attempts are refused without files', async () => {
	const { context, run } = setup();
	await expect(run(() => read({ chat: 'unknown' }))).rejects.toThrow(
		'There is no conversation unknown',
	);
	await expect(
		run(() => draft({ chat: 'unknown', text: 'Hello' })),
	).rejects.toThrow('There is no conversation unknown');
	await expect(run(() => send({ chat: 'unknown' }))).rejects.toThrow(
		'There is no conversation unknown',
	);
	await expect(
		run(() => resolve({ chat, attempt: 'missing', outcome: 'sent' })),
	).rejects.toMatchObject({ name: 'Refused' });
	expect(await context.folder.list()).toEqual([]);
});

test('a refused consume restores every file byte for byte, including optional send fields', async () => {
	for (const previous of [
		undefined,
		'---\nmessageId: "old-message"\nchecked: "2026-11-05T09:00:00.000Z"\nstate: "sent"\nattempt: "old"\nerror: "old error"\nat: "2026-11-05T09:00:00.000Z"\n---\nDelivered reply\n',
	]) {
		const { context, run } = setup(
			previous === undefined ? {} : { 'sends/maya-chen.md': previous },
		);
		await run(() => draft({ chat, text: 'Next reply' }));
		const before = await snapshot(context);
		const update = context.folder.update;
		context.folder.update = (path, revise) => {
			if (path === 'drafts/maya-chen.md')
				throw Object.freeze({
					name: 'Changed',
					message: 'Draft consumption refused',
				});
			return update(path, revise);
		};
		await expect(run(() => send({ chat }))).rejects.toMatchObject({
			name: 'Changed',
		});
		expect(await snapshot(context)).toEqual(before);
		expect(await sent(context)).toHaveLength(0);
	}
});

test('a broken send record leaves conversations readable and blocks sending', async () => {
	for (const body of [
		'---\nstate: "sent"\nat: "2026-11-05T09:00:00.000Z"\n---\nOld reply\n',
		'---\nattempt: "old"\nstate: "sent"\nat: "invalid time"\n---\nOld reply\n',
	]) {
		const { context, run } = setup({ 'sends/maya-chen.md': body });
		const conversation = await run(() => read({ chat }));
		expect(conversation.messages.length).toBeGreaterThan(0);
		expect(conversation.send).toBeUndefined();
		expect(conversation.sendProblems!.length).toBeGreaterThan(0);
		expect(
			(await run(() => conversations({}))).find((row) => row.chat === chat)
				?.sendProblems,
		).toEqual(conversation.sendProblems);
		await run(() => draft({ chat, text: 'Next reply' }));
		await expect(run(() => send({ chat }))).rejects.toMatchObject({
			name: 'Refused',
			message: 'sends/maya-chen.md needs repair before sending to Maya Chen',
		});
		expect(await context.folder.read('sends/maya-chen.md')).toBe(body);
		expect(await sent(context)).toHaveLength(0);
	}
});

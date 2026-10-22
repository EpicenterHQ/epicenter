/**
 * Write Failure Toast Tests
 *
 * Exercises each toast presentation against Sonner's real store and a
 * controlled clipboard. Text is sampled at the interaction boundary, and
 * continuations from retired presentations cannot create another notice.
 *
 * Key behaviors:
 * - Copy reads current text once and exposes that attempted text on refusal
 * - Empty text remains copyable while absent text offers no copy
 * - Save, discard and dismissal retire pending clipboard work
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import type { ComponentProps } from 'svelte';

const { toast } = await import('@epicenter/ui/sonner');
const { on } = await import('svelte/events');
const { toastWriteFailure } = await import('./write-failure-toast.js');
const { default: UnsavedText } = await import('./unsaved-text.svelte');
type Notice = ReturnType<typeof toast.getActiveToasts>[number];
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
	toast.dismiss();
	if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
	else Object.defineProperty(navigator, 'clipboard', clipboard);
});

function recovery(notice: Notice) {
	expect(notice.description).toBe(UnsavedText);
	return notice.componentProps as ComponentProps<typeof UnsavedText>;
}

function clickCopy(notice: Notice) {
	const action = notice.action;
	if (action === undefined || typeof action === 'function')
		throw new Error('Expected a Copy your text action');
	expect(action.label).toBe('Copy your text');
	const button = document.createElement('button');
	let prevented = false;
	const stop = on(button, 'click', (event) => {
		action.onClick(event);
		prevented = event.defaultPrevented;
	});
	button.click();
	stop();
	expect(prevented).toBe(true);
}

function clickSave(notice: Notice) {
	const control = notice.cancel ?? notice.action;
	if (control === undefined || typeof control === 'function')
		throw new Error('Expected a Save again control');
	expect(control.label).toBe('Save again');
	const button = document.createElement('button');
	const stop = on(button, 'click', (event) => control.onClick(event));
	button.click();
	stop();
}

function show({
	text,
	save,
	withSave = true,
	discard,
}: {
	text: { current: string | undefined };
	save?: (() => boolean) | undefined;
	withSave?: boolean;
	discard?: (() => string | undefined) | undefined;
}) {
	toastWriteFailure({
		path: 'notes/a.md',
		error: { name: 'Unavailable', message: 'Disk is full.' },
		getText: () => text.current,
		save: withSave ? (save ?? (() => true)) : undefined,
		discard,
	});
	return currentNotice();
}

function currentNotice() {
	const active = toast.getActiveToasts();
	expect(active).toHaveLength(1);
	const [notice] = active;
	if (notice === undefined) throw new Error('Expected a failure notice');
	return notice;
}

async function until(check: () => boolean) {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for toast state');
}

test('Copy reads the newest text once and waits for clipboard success', async () => {
	const copied = Promise.withResolvers<void>();
	const writeText = mock(() => copied.promise);
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const text = { current: 'older' as string | undefined };
	const notice = show({ text });
	text.current = 'newest\r\n';
	clickCopy(notice);
	text.current = 'later';
	clickCopy(notice);
	expect(writeText).toHaveBeenCalledTimes(1);
	expect(writeText).toHaveBeenCalledWith('newest\r\n');
	copied.resolve();
	await until(() => toast.getActiveToasts().length === 0);
});

test('a rejected Copy shows its attempted text and the next Copy reads newest text', async () => {
	const writeText = mock(async () => {
		if (writeText.mock.calls.length === 1) throw new Error('Clipboard refused');
	});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const text = { current: 'attempted' as string | undefined };
	const notice = show({ text });
	clickCopy(notice);
	text.current = 'newest';
	await until(() => toast.getActiveToasts()[0]?.id !== notice.id);
	const replacement = currentNotice();
	expect(recovery(replacement).text).toBe('attempted');
	expect(recovery(replacement).message).toContain('Copying did not work');
	clickCopy(replacement);
	await until(() => toast.getActiveToasts().length === 0);
	expect(writeText).toHaveBeenLastCalledWith('newest');
});

test.each(['attempted', ''])(
	'a refused Copy retains its manual fallback when current input disappeared (%j)',
	async (attempted) => {
		const copied = Promise.withResolvers<void>();
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: () => copied.promise },
		});
		const text = { current: attempted as string | undefined };
		const notice = show({ text, discard: () => text.current });
		clickCopy(notice);
		text.current = undefined;
		copied.reject(new Error('Clipboard refused'));
		await until(() => toast.getActiveToasts()[0]?.id !== notice.id);
		const fallback = currentNotice();
		expect(recovery(fallback).text).toBe(attempted);
		expect(fallback.duration).toBe(Number.POSITIVE_INFINITY);
		expect(recovery(fallback).message).not.toContain('still on screen');
		expect(recovery(fallback).discard).toBeUndefined();
		expect(fallback.action).toBeUndefined();
		expect(fallback.cancel).toBeUndefined();
	},
);

test('Discard after a rejected Copy shows and copies the newest dropped text', async () => {
	const writeText = mock(async () => {
		if (writeText.mock.calls.length === 1) throw new Error('Clipboard refused');
	});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const text = { current: 'attempted A' as string | undefined };
	const notice = show({ text, discard: () => text.current });
	clickCopy(notice);
	await until(() => toast.getActiveToasts()[0]?.id !== notice.id);
	const fallback = currentNotice();
	expect(recovery(fallback).text).toBe('attempted A');
	text.current = 'dropped newest';
	const { discard } = recovery(fallback);
	if (discard === undefined) throw new Error('Expected a discard control');
	discard();
	const detached = currentNotice();
	expect(recovery(detached).text).toBe('dropped newest');
	clickCopy(detached);
	await until(() => toast.getActiveToasts().length === 0);
	expect(writeText).toHaveBeenLastCalledWith('dropped newest');
});

test('Copy dismisses without clipboard access when current text disappeared', async () => {
	const writeText = mock(async () => {});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const text = { current: 'held' as string | undefined };
	const notice = show({ text });
	text.current = undefined;
	clickCopy(notice);
	await until(() => toast.getActiveToasts().length === 0);
	expect(writeText).not.toHaveBeenCalled();
});

test('undefined text offers no Copy while empty text remains copyable', async () => {
	const missing = show({ text: { current: undefined }, withSave: false });
	expect(missing.action).toBeUndefined();
	toast.dismiss(missing.id);
	const writeText = mock(async () => {});
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const empty = show({ text: { current: '' }, withSave: false });
	expect(empty.duration).toBe(Number.POSITIVE_INFINITY);
	clickCopy(empty);
	await until(() => toast.getActiveToasts().length === 0);
	expect(writeText).toHaveBeenCalledWith('');
});

test('Discard replaces the notice with the latest text, including empty text', () => {
	const text = { current: 'older' as string | undefined };
	const notice = show({ text, discard: () => text.current });
	text.current = '';
	const { discard } = recovery(notice);
	if (discard === undefined) throw new Error('Expected a discard control');
	discard();
	const replacement = currentNotice();
	expect(recovery(replacement).text).toBe('');
	expect(recovery(replacement).discard).toBeUndefined();
	expect(replacement.duration).toBe(Number.POSITIVE_INFINITY);
});

test('Discard that finds no text dismisses without another notice', async () => {
	const notice = show({
		text: { current: 'held' },
		discard: () => undefined,
	});
	const { discard } = recovery(notice);
	if (discard === undefined) throw new Error('Expected a discard control');
	discard();
	await until(() => toast.getActiveToasts().length === 0);
});

test('a refused Save again keeps live text but removes the Save control', () => {
	const text = { current: 'held' as string | undefined };
	const notice = show({ text, save: () => false });
	clickSave(notice);
	const replacement = currentNotice();
	expect(replacement.id).not.toBe(notice.id);
	expect(replacement.cancel).toBeUndefined();
	text.current = 'newest';
	const action = replacement.action;
	if (action === undefined || typeof action === 'function')
		throw new Error('Expected the Copy your text action');
	expect(action.label).toBe('Copy your text');
});

test.each(['discard', 'save', 'dismiss'] as const)(
	'a pending Copy rejection cannot revive a notice after %s',
	async (retire) => {
		const copied = Promise.withResolvers<void>();
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: () => copied.promise },
		});
		const text = { current: 'attempted' as string | undefined };
		const notice = show({ text, discard: () => text.current });
		clickCopy(notice);
		text.current = 'newest';
		if (retire === 'discard') {
			const { discard } = recovery(notice);
			if (discard === undefined) throw new Error('Expected a discard control');
			discard();
		} else if (retire === 'save') clickSave(notice);
		else {
			notice.onDismiss?.(notice);
			toast.dismiss(notice.id);
		}
		const replacement = toast.getActiveToasts()[0];
		copied.reject(new Error('Clipboard refused late'));
		await Bun.sleep(5);
		if (retire === 'discard') {
			if (replacement === undefined)
				throw new Error('Expected the detached failure notice');
			expect(currentNotice().id).toBe(replacement.id);
			expect(recovery(currentNotice()).text).toBe('newest');
		} else expect(toast.getActiveToasts()).toEqual([]);
	},
);

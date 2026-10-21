/**
 * Failed-save recovery through Sonner's real toast store and a controlled
 * clipboard. Copy waits for success, failed copies expose the original text,
 * and discarding retains any text typed after the notice was first shown.
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

function show(unsaved: string, discard?: () => string) {
	toastWriteFailure({
		path: 'notes/a.md',
		error: { name: 'Unavailable', message: 'Disk is full.' },
		unsaved,
		save: () => true,
		discard,
	});
	const notice = currentNotice();
	expect(notice.duration).toBe(Number.POSITIVE_INFINITY);
	return notice;
}

function currentNotice() {
	const active = toast.getActiveToasts();
	expect(active).toHaveLength(1);
	const [notice] = active;
	if (notice === undefined) throw new Error('Expected a recovery notice');
	return notice;
}

async function until(check: () => boolean) {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for clipboard recovery');
}

test('Copy keeps its notice until the clipboard accepts the text and ignores another click', async () => {
	const copied = Promise.withResolvers<void>();
	const writeText = mock(() => copied.promise);
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
	const notice = show('my only copy\r\n');
	clickCopy(notice);
	clickCopy(notice);
	expect(writeText).toHaveBeenCalledTimes(1);
	expect(writeText).toHaveBeenCalledWith('my only copy\r\n');
	expect(toast.getActiveToasts()).toHaveLength(1);
	copied.resolve();
	await until(() => toast.getActiveToasts().length === 0);
});

test.each(['refused', 'unavailable'] as const)(
	'%s clipboard access replaces the notice with manually copyable text',
	async (state) => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value:
				state === 'unavailable'
					? undefined
					: {
							writeText: async () => {
								throw new Error('Clipboard refused');
							},
						},
		});
		const notice = show('my only copy\r\n');
		clickCopy(notice);
		await until(() => toast.getActiveToasts()[0]?.id !== notice.id);
		const replacement = currentNotice();
		const props = recovery(replacement);
		expect(props.text).toBe('my only copy\r\n');
		expect(props.message).toContain('Copying did not work');
		expect(replacement.duration).toBe(Number.POSITIVE_INFINITY);
	},
);

test('Discard replaces the notice with the latest text returned by the editor', () => {
	const notice = show('older text', () => 'newer text');
	const { discard } = recovery(notice);
	if (discard === undefined) throw new Error('Expected a discard control');
	discard();
	const replacement = currentNotice();
	expect(recovery(replacement).text).toBe('newer text');
	expect(recovery(replacement).discard).toBeUndefined();
});

/**
 * Closing Tests
 *
 * Drives `createClosing` the way a desktop page's close handler does: each
 * `request` is one close request from the shell, which awaits it and then
 * destroys the window unless `preventDefault` was called.
 *
 * Key behaviors:
 * - A request awaits the owner's close, with no timeout, and keeps nothing open
 * - `slow` turns on only after `slowAfter`, and off once the close ends
 * - Close anyway ends the wait while the close still runs
 * - Every request joins one close, and a close that rejects still lets the
 *   window go
 * - `confirm` answering false keeps the window open and closes nothing; a
 *   second request while it is asked joins the same answer
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';

const { createClosing } = await import('./closing.svelte.ts');

/** A close request as the shell sends it, recording whether it was kept open. */
function request() {
	const event = {
		kept: false,
		preventDefault() {
			event.kept = true;
		},
	};
	return event;
}

test('a request waits for the close, however long, and keeps nothing open', async () => {
	const closed = Promise.withResolvers<void>();
	let closes = 0;
	const closing = createClosing({
		close: () => {
			closes++;
			return closed.promise;
		},
	});
	const event = request();
	let ended = false;
	const handled = closing.request(event).then(() => {
		ended = true;
	});
	await Bun.sleep(20);
	expect(ended).toBe(false);
	closed.resolve();
	await handled;
	expect(closes).toBe(1);
	expect(event.kept).toBe(false);
});

test('the notice shows only after the threshold, and goes when the close ends', async () => {
	const closed = Promise.withResolvers<void>();
	const closing = createClosing({ close: () => closed.promise, slowAfter: 40 });
	const handled = closing.request(request());
	await Bun.sleep(10);
	expect(closing.slow).toBe(false);
	await Bun.sleep(60);
	expect(closing.slow).toBe(true);
	closed.resolve();
	await handled;
	expect(closing.slow).toBe(false);
});

test('a close that ends before the threshold never shows the notice', async () => {
	const closing = createClosing({ close: async () => {}, slowAfter: 20 });
	await closing.request(request());
	await Bun.sleep(40);
	expect(closing.slow).toBe(false);
});

test('Close anyway ends the wait while the close still runs', async () => {
	const closing = createClosing({
		close: () => new Promise(() => {}),
		slowAfter: 10,
	});
	const event = request();
	const handled = closing.request(event);
	await Bun.sleep(30);
	expect(closing.slow).toBe(true);
	closing.closeAnyway();
	await handled;
	expect(closing.slow).toBe(false);
	expect(event.kept).toBe(false);
	// A later request does not wait again.
	await closing.request(request());
});

test('every request joins one close, and a close that rejects still lets the window go', async () => {
	const closed = Promise.withResolvers<void>();
	let closes = 0;
	const closing = createClosing({
		close: () => {
			closes++;
			return closed.promise;
		},
	});
	const first = closing.request(request());
	const second = closing.request(request());
	closed.reject(new Error('the folder went away'));
	await Promise.all([first, second]);
	expect(closes).toBe(1);
});

test('confirm answering false keeps the window open, closes nothing, and a second request joins the ask', async () => {
	const answer = Promise.withResolvers<boolean>();
	let asked = 0;
	let closes = 0;
	const closing = createClosing({
		close: async () => {
			closes++;
		},
		confirm: () => {
			asked++;
			return answer.promise;
		},
	});
	const first = request();
	const second = request();
	const handled = [closing.request(first), closing.request(second)];
	await Bun.sleep(5);
	expect(asked).toBe(1);
	answer.resolve(false);
	await Promise.all(handled);
	expect(first.kept).toBe(true);
	expect(second.kept).toBe(true);
	expect(closes).toBe(0);
});

test('confirm answering true closes once, and a request during the close is not asked again', async () => {
	const closed = Promise.withResolvers<void>();
	let asked = 0;
	let closes = 0;
	const closing = createClosing({
		close: () => {
			closes++;
			return closed.promise;
		},
		confirm: () => {
			asked++;
			return true;
		},
	});
	const first = closing.request(request());
	await Bun.sleep(5);
	const second = request();
	const joined = closing.request(second);
	closed.resolve();
	await Promise.all([first, joined]);
	expect(asked).toBe(1);
	expect(closes).toBe(1);
	expect(second.kept).toBe(false);
});

test('after a Cancel, the next request asks again', async () => {
	const answers = [false, true];
	let asked = 0;
	let closes = 0;
	const closing = createClosing({
		close: async () => {
			closes++;
		},
		confirm: () => answers[asked++] ?? true,
	});
	const kept = request();
	await closing.request(kept);
	expect(kept.kept).toBe(true);
	expect(closes).toBe(0);
	const closed = request();
	await closing.request(closed);
	expect(closed.kept).toBe(false);
	expect(asked).toBe(2);
	expect(closes).toBe(1);
});

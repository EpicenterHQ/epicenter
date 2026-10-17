/**
 * Home Section Tests
 *
 * How Settings follows the section an app asked the shell to open.
 *
 * Key behaviors:
 * - A request made before Settings opened is shown when it mounts
 * - A nudge claims the request again and shows it; an empty claim shows nothing
 * - The first claim waits until the nudge is heard, so no request falls between
 * - After stop, nothing is shown and the listener is removed; stop before
 *   listening began claims nothing, so the request stays in the shell
 * - Listening that fails still claims once, and a claim that fails is
 *   logged, not thrown
 * - The view follows the section while content above it moves, until the
 *   person scrolls or the settle time passes
 */
import { expect, test } from 'bun:test';
import type { HomeSection } from './bindings.gen';
import {
	followHomeSections,
	keepInView,
	type ViewEnvironment,
} from './home-section.ts';

/** A shell holding at most one request, as `PendingHomeSection` does. */
function shell(pending: HomeSection | null = null) {
	let request = pending;
	let nudge: (() => void) | undefined;
	let listening = false;
	return {
		request(section: HomeSection) {
			request = section;
			nudge?.();
		},
		claim: async () => {
			const taken = request;
			request = null;
			return taken;
		},
		onNudge: async (nudged: () => void) => {
			nudge = nudged;
			listening = true;
			return () => {
				nudge = undefined;
				listening = false;
			};
		},
		get listening() {
			return listening;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a request made before Settings opened is shown when it mounts', async () => {
	const host = shell('transcription');
	const shown: HomeSection[] = [];
	followHomeSections({ ...host, show: (section) => shown.push(section) });
	await settle();
	expect(shown).toEqual(['transcription']);
});

test('a nudge shows the request it announces, once', async () => {
	const host = shell();
	const shown: HomeSection[] = [];
	followHomeSections({ ...host, show: (section) => shown.push(section) });
	await settle();
	expect(shown).toEqual([]);

	host.request('transcription');
	await settle();
	expect(shown).toEqual(['transcription']);
});

test('the first claim waits until the nudge is heard', async () => {
	const host = shell();
	const order: string[] = [];
	followHomeSections({
		claim: async () => {
			order.push('claim');
			return null;
		},
		onNudge: async (nudged) => {
			await settle();
			order.push('listening');
			return host.onNudge(nudged);
		},
		show: () => undefined,
	});
	await settle();
	await settle();
	expect(order).toEqual(['listening', 'claim']);
});

test('after stop, a nudge shows nothing and the listener is removed', async () => {
	const host = shell();
	const shown: HomeSection[] = [];
	const stop = followHomeSections({
		...host,
		show: (section) => shown.push(section),
	});
	await settle();
	expect(host.listening).toBe(true);

	stop();
	await settle();
	host.request('transcription');
	await settle();
	expect(shown).toEqual([]);
	expect(host.listening).toBe(false);
});

test('stop before listening began claims nothing, so the request stays in the shell', async () => {
	const host = shell('transcription');
	const shown: HomeSection[] = [];
	let heard: (stop: () => void) => void = () => undefined;
	const stop = followHomeSections({
		claim: host.claim,
		onNudge: () => new Promise((resolve) => (heard = resolve)),
		show: (section) => shown.push(section),
	});
	stop();
	heard(() => undefined);
	await settle();
	expect(shown).toEqual([]);
	expect(await host.claim()).toBe('transcription');
});

test('listening that fails still claims the request once', async () => {
	const host = shell('transcription');
	const shown: HomeSection[] = [];
	const stop = followHomeSections({
		claim: host.claim,
		onNudge: async () => {
			throw new Error('no event permission');
		},
		show: (section) => shown.push(section),
	});
	await settle();
	expect(shown).toEqual(['transcription']);
	// Stopping after a failed listen has nothing to remove and does not throw.
	stop();
	await settle();
});

test('a claim that fails shows nothing and does not throw', async () => {
	const host = shell();
	const shown: HomeSection[] = [];
	followHomeSections({
		claim: async () => {
			throw new Error('the shell did not answer');
		},
		onNudge: host.onNudge,
		show: (section) => shown.push(section),
	});
	await settle();
	expect(shown).toEqual([]);
});

/** A page whose frames, clock, and input a test drives. */
function page() {
	const frames = new Map<number, () => void>();
	let next = 0;
	let time = 0;
	let input: (() => void) | undefined;
	const environment: ViewEnvironment = {
		frame(callback) {
			next += 1;
			frames.set(next, callback);
			return next;
		},
		cancelFrame: (id) => frames.delete(id),
		now: () => time,
		onInput(handler) {
			input = handler;
			return () => (input = undefined);
		},
	};
	return {
		environment,
		/** Run the pending frame, `ms` after the last. */
		tick(ms = 16) {
			time += ms;
			const pending = [...frames.entries()];
			frames.clear();
			for (const [, callback] of pending) callback();
		},
		input: () => input?.(),
		get waiting() {
			return frames.size > 0 || input !== undefined;
		},
	};
}

/** A section whose top moves when content above it grows, and scrolls back to 0. */
function section() {
	let top = 400;
	let scrolls = 0;
	return {
		getBoundingClientRect: () => ({ top }) as DOMRect,
		scrollIntoView() {
			scrolls += 1;
			top = 0;
		},
		/** Content above loaded: the section moved down. */
		pushDown: (by: number) => (top += by),
		get scrolls() {
			return scrolls;
		},
	};
}

test('the view follows the section while content above it loads, then lets go', () => {
	const view = page();
	const target = section();
	keepInView(target, { settleMs: 100, environment: view.environment });
	expect(target.scrolls).toBe(1);

	view.tick();
	expect(target.scrolls).toBe(1);
	target.pushDown(120);
	view.tick();
	expect(target.scrolls).toBe(2);

	view.tick(200);
	expect(view.waiting).toBe(false);
	target.pushDown(50);
	view.tick();
	expect(target.scrolls).toBe(2);
});

test('the person scrolling or typing ends the follow at once', () => {
	const view = page();
	const target = section();
	keepInView(target, { environment: view.environment });
	view.input();
	expect(view.waiting).toBe(false);
	target.pushDown(120);
	view.tick();
	expect(target.scrolls).toBe(1);
});

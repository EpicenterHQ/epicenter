/**
 * Flush on Close Tests
 *
 * Drives `flushOnClose` with a scripted host close signal, real admissions,
 * and a stand-in session whose writes the test releases.
 *
 * Key behaviors:
 * - A close sends the held snapshot and waits for it to land
 * - A close completes within the bound when a save hangs
 * - A draft whose save failed does not hold the close
 * - `pagehide` starts the same flush; stopping removes both listeners
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { FlushOutcome } from './flush-on-close.js';
import { flushOnClose, flushWithin } from './flush-on-close.js';

const { createAdmissions } = await import('./admissions.svelte.ts');

/**
 * One file's saves, as autosave runs them: one write at a time, and a request
 * made meanwhile is held until the running write finishes.
 */
function standInSession() {
	const written: string[] = [];
	const writes: PromiseWithResolvers<void>[] = [];
	let running: Promise<void> | undefined;
	let held: string | undefined;

	function write(text: string): Promise<void> {
		const landing = Promise.withResolvers<void>();
		writes.push(landing);
		return landing.promise.then(() => {
			written.push(text);
			if (held === undefined) {
				running = undefined;
				return;
			}
			const next = held;
			held = undefined;
			running = write(next);
			return running;
		});
	}

	return {
		written,
		/** Finish the oldest write still running. */
		land() {
			writes.shift()?.resolve();
		},
		request(text: string) {
			if (running === undefined) running = write(text);
			else held = text;
		},
		async settled() {
			while (running !== undefined) await running;
		},
	};
}

/** A host that sends one close signal and records each acknowledgement. */
function scriptedHost() {
	let respond: (() => Promise<FlushOutcome>) | undefined;
	let listening = true;
	return {
		signal: (run: () => Promise<FlushOutcome>) => {
			respond = run;
			return () => {
				listening = false;
			};
		},
		async close(): Promise<FlushOutcome | undefined> {
			if (!listening || respond === undefined) return undefined;
			return respond();
		},
		get listening() {
			return listening;
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a close sends the held snapshot and waits for it to land', async () => {
	const session = standInSession();
	const admissions = createAdmissions();
	const host = scriptedHost();
	const stop = flushOnClose(
		async () => {
			await admissions.quiet();
			await session.settled();
		},
		{ hostClose: host.signal },
	);
	await tick();

	session.request('first');
	session.request('latest');
	const closing = host.close();
	session.land();
	await tick();
	session.land();

	expect(await closing).toBe('flushed');
	expect(session.written).toEqual(['first', 'latest']);
	stop();
});

test('a close completes within the bound when a save hangs', async () => {
	const session = standInSession();
	const host = scriptedHost();
	flushOnClose(() => session.settled(), { hostClose: host.signal, ms: 40 });
	await tick();

	session.request('never lands');
	const started = performance.now();
	expect(await host.close()).toBe('timed-out');
	expect(performance.now() - started).toBeLessThan(500);
	expect(session.written).toEqual([]);
});

test('a draft whose save failed does not hold the close', async () => {
	// A failed save is settled: the session reports the error and holds nothing.
	const failed = {
		settled: async () => ({ status: 'error' as const }),
	};
	expect(await flushWithin(() => failed.settled(), 1_000)).toBe('flushed');
	expect(
		await flushWithin(async () => {
			throw new Error('the folder refused');
		}, 1_000),
	).toBe('failed');
});

test('admitted work that is still running holds the close until the bound', async () => {
	const admissions = createAdmissions();
	const running = Promise.withResolvers<void>();
	void admissions.admit(() => running.promise);
	expect(await flushWithin(() => admissions.quiet(), 30)).toBe('timed-out');
	const quiet = flushWithin(() => admissions.quiet(), 1_000);
	running.resolve();
	expect(await quiet).toBe('flushed');
});

test('pagehide starts the flush, and stopping removes both listeners', async () => {
	let flushes = 0;
	const host = scriptedHost();
	const stop = flushOnClose(
		async () => {
			flushes += 1;
		},
		{ hostClose: host.signal },
	);
	await tick();
	globalThis.dispatchEvent(new Event('pagehide'));
	await tick();
	expect(flushes).toBe(1);

	stop();
	globalThis.dispatchEvent(new Event('pagehide'));
	await tick();
	expect(flushes).toBe(1);
	expect(host.listening).toBe(false);
});

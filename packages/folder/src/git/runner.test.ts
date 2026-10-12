/**
 * Pass Runner and Commit Message Tests
 *
 * The runner orders a folder's Git passes: one at a time, entered by
 * `attempt` for work nobody waits on, by `request` for a caller that does, and
 * by `follow` for callers content to share the next pass. Commit subjects are
 * derived from captured tree changes (ADR-0469).
 *
 * Key behaviors:
 * - `attempt` starts a pass only when nothing runs or waits; otherwise it does
 *   nothing and never runs later
 * - `request` waits for the passes ahead and runs its own, in arrival order;
 *   a caller that left before its turn never starts a pass
 * - `follow` shares one pass that has not started; nobody joins a running one
 * - `close` aborts the active pass, waits for it, and tells waiting callers
 *   and later ones that the runner closed, whatever else they asked for
 * - A throwing pass becomes a result and the runner keeps working
 * - Subjects name one path or count several, escape control characters, and
 *   fall back past 72 characters; user messages must be nonempty text
 *
 * See also:
 * - `history.test.ts` for close ordering across commit and push runners
 */
import { describe, expect, test } from 'bun:test';
import { commitSubject, escapePath } from './messages.js';
import { createPassRunner } from './runner.js';

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function counting({ obeysAbort = true } = {}) {
	const gates: ReturnType<typeof gate>[] = [];
	let starts = 0;
	let changes = 0;
	const runner = createPassRunner<string, string>({
		async run(input, signal) {
			const index = starts++;
			const current = gate();
			gates.push(current);
			await Promise.race([
				current.opened,
				new Promise<void>((resolve) => {
					if (obeysAbort) signal.addEventListener('abort', () => resolve());
				}),
			]);
			return obeysAbort && signal.aborted
				? `aborted ${index}`
				: `pass ${index} ${input}`;
		},
		failed: (cause) => `failed ${String(cause)}`,
		closed: () => 'closed',
		onChange: () => changes++,
	});
	return { runner, gates, starts: () => starts, changes: () => changes };
}

describe('createPassRunner', () => {
	test('an attempt starts a pass when idle; one made during a pass does nothing and never runs later', async () => {
		const { runner, gates, starts, changes } = counting();
		const first = runner.attempt('a');
		await Bun.sleep(0);
		expect(starts()).toBe(1);
		expect(runner.active).toBe(true);
		const before = changes();
		expect(runner.attempt('b')).toBeUndefined();
		expect(runner.attempt('c')).toBeUndefined();
		// A skipped attempt changed nothing an observer could see.
		expect(changes()).toBe(before);
		gates[0]!.open();
		expect(await first).toBe('pass 0 a');
		expect(runner.active).toBe(false);
		await Bun.sleep(5);
		expect(starts()).toBe(1);
		const next = runner.attempt('d');
		await Bun.sleep(0);
		gates[1]!.open();
		expect(await next).toBe('pass 1 d');
	});

	test('requests wait for the passes ahead and each runs its own, in order', async () => {
		const { runner, gates, starts } = counting();
		const first = runner.request('a');
		const second = runner.request('b');
		const third = runner.request('c');
		await Bun.sleep(0);
		expect(starts()).toBe(1);
		gates[0]!.open();
		expect(await first).toBe('pass 0 a');
		await Bun.sleep(0);
		expect(starts()).toBe(2);
		gates[1]!.open();
		expect(await second).toBe('pass 1 b');
		await Bun.sleep(0);
		gates[2]!.open();
		expect(await third).toBe('pass 2 c');
		expect(starts()).toBe(3);
	});

	test('an attempt does not start between a finished pass and a caller already waiting', async () => {
		const { runner, gates, starts } = counting();
		const first = runner.request('a');
		const waiting = runner.request('b');
		await Bun.sleep(0);
		gates[0]!.open();
		await first;
		// The pass ended this instant; the waiter's turn has not begun yet.
		expect(runner.attempt('unawaited')).toBeUndefined();
		await Bun.sleep(0);
		gates[1]!.open();
		expect(await waiting).toBe('pass 1 b');
		expect(starts()).toBe(2);
	});

	test('a request whose caller left before its turn never starts; one that left after it started runs on', async () => {
		const { runner, gates, starts } = counting();
		const leaving = (controller: AbortController) => ({
			signal: controller.signal,
			withdrawn: () => 'withdrawn',
		});
		const first = runner.request('a');
		const queued = new AbortController();
		const second = runner.request('b', leaving(queued));
		const third = runner.request('c');
		await Bun.sleep(0);
		queued.abort();
		gates[0]!.open();
		expect(await first).toBe('pass 0 a');
		expect(await second).toBe('withdrawn');
		await Bun.sleep(0);
		// The pass after the withdrawn one is `c`, not `b`.
		expect(starts()).toBe(2);
		gates[1]!.open();
		expect(await third).toBe('pass 1 c');

		// Already aborted when asked: nothing starts, and the runner is free.
		expect(await runner.request('d', leaving(queued))).toBe('withdrawn');
		expect(starts()).toBe(2);

		// Aborted after its pass started: the pass is not interrupted.
		const started = new AbortController();
		const fourth = runner.request('e', leaving(started));
		await Bun.sleep(0);
		started.abort();
		gates[2]!.open();
		expect(await fourth).toBe('pass 2 e');
	});

	test('followers share one pass that starts after they asked and never join a running one', async () => {
		const { runner, gates, starts } = counting();
		// Asked together while idle: one pass serves both.
		const a = runner.follow('a');
		const b = runner.follow('b');
		expect(b).toBe(a);
		await Bun.sleep(0);
		expect(starts()).toBe(1);

		// Asked while that pass runs: one more pass, shared, not the running one.
		const c = runner.follow('c');
		const d = runner.follow('d');
		expect(c).not.toBe(a);
		expect(d).toBe(c);
		await Bun.sleep(5);
		expect(starts()).toBe(1);
		gates[0]!.open();
		expect(await a).toBe('pass 0 a');
		await Bun.sleep(0);
		expect(starts()).toBe(2);

		// Asked while the follower runs: the next pass, not this one.
		const e = runner.follow('e');
		expect(e).not.toBe(c);
		gates[1]!.open();
		expect(await c).toBe('pass 1 c');
		await Bun.sleep(0);
		gates[2]!.open();
		expect(await e).toBe('pass 2 e');
		expect(starts()).toBe(3);
	});

	test('close tells a waiting follower and a waiting caller that left that the runner closed', async () => {
		const { runner, starts } = counting();
		const first = runner.request('a');
		const follower = runner.follow('b');
		const controller = new AbortController();
		const leaver = runner.request('c', {
			signal: controller.signal,
			withdrawn: () => 'withdrawn',
		});
		await Bun.sleep(0);
		controller.abort();
		await runner.close();
		expect(await first).toBe('aborted 0');
		expect(await follower).toBe('closed');
		// Closing is the host's refusal and is reported before the caller's own.
		expect(await leaver).toBe('closed');
		expect(await runner.follow('d')).toBe('closed');
		expect(starts()).toBe(1);
	});

	test('close aborts the active pass, waits for it, and tells waiting and later callers it closed', async () => {
		const { runner, starts } = counting();
		const first = runner.request('a');
		const waiting = runner.request('b');
		await Bun.sleep(0);
		await runner.close();
		expect(await first).toBe('aborted 0');
		expect(await waiting).toBe('closed');
		expect(runner.active).toBe(false);
		expect(await runner.request('c')).toBe('closed');
		expect(runner.attempt('d')).toBeUndefined();
		expect(starts()).toBe(1);
	});

	test('close waits for a pass that ignores its signal, and that pass reports what it really did', async () => {
		const { runner, gates } = counting({ obeysAbort: false });
		const first = runner.request('a');
		await Bun.sleep(0);
		let closed = false;
		const closing = runner.close().then(() => {
			closed = true;
		});
		expect(await runner.request('b')).toBe('closed');
		await Bun.sleep(5);
		expect(closed).toBe(false);
		gates[0]!.open();
		await closing;
		expect(await first).toBe('pass 0 a');
	});

	test('a throwing pass becomes a result and the runner keeps working', async () => {
		let calls = 0;
		const runner = createPassRunner<void, string>({
			async run() {
				calls++;
				if (calls === 1) throw new Error('boom');
				return 'ok';
			},
			failed: (cause) => `failed: ${(cause as Error).message}`,
			closed: () => 'closed',
		});
		expect(await runner.request()).toBe('failed: boom');
		expect(await runner.request()).toBe('ok');
	});
});

describe('commit subjects', () => {
	test('name one path by its change and count several', () => {
		expect(commitSubject([{ path: 'todos/a.md', kind: 'add' }])).toBe(
			'Add todos/a.md',
		);
		expect(commitSubject([{ path: 'todos/a.md', kind: 'modify' }])).toBe(
			'Update todos/a.md',
		);
		expect(commitSubject([{ path: 'todos/a.md', kind: 'delete' }])).toBe(
			'Delete todos/a.md',
		);
		expect(
			commitSubject([
				{ path: 'todos/a.md', kind: 'delete' },
				{ path: 'todos/b.md', kind: 'add' },
			]),
		).toBe('Update 2 files');
		expect(commitSubject([])).toBeUndefined();
	});

	test('escape control characters and fall back past 72 characters', () => {
		expect(escapePath('a\nb\\c')).toBe('a\\x0ab\\\\c');
		expect(commitSubject([{ path: 'x\ny.md', kind: 'add' }])).toBe(
			'Add x\\x0ay.md',
		);
		expect(
			commitSubject([{ path: `${'a'.repeat(70)}.md`, kind: 'modify' }]),
		).toBe('Update 1 file');
	});
});

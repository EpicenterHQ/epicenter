/**
 * Pass Runner and Commit Message Tests
 *
 * The runner is the folder's only Git scheduling primitive: one active pass
 * and at most one pending pass, no timers. Commit subjects are derived from
 * captured tree changes (ADR-0469).
 *
 * Key behaviors:
 * - An idle runner starts at once; requests during a pass share one pending pass
 * - `drain` finishes admitted passes; `cancel` skips pending and aborts active
 * - A throwing pass becomes a result and the runner keeps working
 * - Subjects name one path or count several, escape control characters, and
 *   fall back past 72 characters; user messages must be nonempty text
 *
 * See also:
 * - `history.test.ts` for close ordering across commit and push runners
 */
import { describe, expect, test } from 'bun:test';
import { commitSubject, escapePath, messageProblem } from './messages.js';
import { createPassRunner } from './runner.js';

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function counting() {
	const gates: ReturnType<typeof gate>[] = [];
	let starts = 0;
	const runner = createPassRunner<string>({
		async run(signal) {
			const index = starts++;
			const current = gate();
			gates.push(current);
			await Promise.race([
				current.opened,
				new Promise<void>((resolve) =>
					signal.addEventListener('abort', () => resolve()),
				),
			]);
			return signal.aborted ? `aborted ${index}` : `pass ${index}`;
		},
		failed: (cause) => `failed ${String(cause)}`,
		closed: () => 'closed',
		cancelled: () => 'cancelled',
	});
	return { runner, gates, starts: () => starts };
}

describe('createPassRunner', () => {
	test('starts immediately when idle and coalesces requests into one pending pass', async () => {
		const { runner, gates, starts } = counting();
		const first = runner.request();
		expect(starts()).toBe(1);
		const second = runner.request();
		const third = runner.request();
		expect(runner.pending).toBe(true);
		expect(starts()).toBe(1);
		gates[0]!.open();
		expect(await first).toBe('pass 0');
		await Bun.sleep(0);
		expect(starts()).toBe(2);
		gates[1]!.open();
		expect(await second).toBe('pass 1');
		expect(await third).toBe('pass 1');
		expect(runner.active).toBe(false);
	});

	test('drain lets admitted active and pending passes finish and fences new requests', async () => {
		const { runner, gates } = counting();
		const first = runner.request();
		const pending = runner.request();
		const closing = runner.close('drain');
		expect(await runner.request()).toBe('closed');
		gates[0]!.open();
		await Bun.sleep(0);
		gates[1]!.open();
		await closing;
		expect(await first).toBe('pass 0');
		expect(await pending).toBe('pass 1');
	});

	test('cancel skips the pending pass and aborts the active one, waiting for it to settle', async () => {
		const { runner, starts } = counting();
		const first = runner.request();
		const pending = runner.request();
		await runner.close('cancel');
		expect(await first).toBe('aborted 0');
		expect(await pending).toBe('cancelled');
		expect(starts()).toBe(1);
	});

	test('a throwing pass becomes a result and the runner keeps working', async () => {
		let calls = 0;
		const runner = createPassRunner<string>({
			async run() {
				calls++;
				if (calls === 1) throw new Error('boom');
				return 'ok';
			},
			failed: (cause) => `failed: ${(cause as Error).message}`,
			closed: () => 'closed',
			cancelled: () => 'cancelled',
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

	test('user messages must be nonempty and free of control characters', () => {
		expect(messageProblem('  ')).toBeDefined();
		expect(messageProblem('ok\x00')).toBeDefined();
		expect(messageProblem('Fix typo\n\nDetails')).toBeUndefined();
	});
});

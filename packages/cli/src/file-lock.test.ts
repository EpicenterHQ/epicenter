/**
 * File Lock Tests
 *
 * Key behaviors:
 * - Another process cannot take a held lock; it is refused as
 *   `NothingChanged` once its wait ends, and its work never runs
 * - Work in one process takes turns on one lock, in order
 * - A link at the lock path is refused before anything is opened
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdingFileLock, NothingChanged } from './file-lock.ts';

const BOX = mkdtempSync(join(tmpdir(), 'epicenter-file-lock-'));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

test('another process is refused a held lock as NothingChanged', async () => {
	const lock = join(BOX, 'held', 'a.lock');
	const held = Promise.withResolvers<void>();
	const holding = holdingFileLock(
		lock,
		{ waitMs: 0, held: 'first' },
		() => held.promise,
	);
	const refused = Bun.spawn(
		[
			'bun',
			'-e',
			`
			const { holdingFileLock, NothingChanged } = await import(${JSON.stringify(join(import.meta.dir, 'file-lock.ts'))});
			await holdingFileLock(process.argv.at(-1), { waitMs: 0, held: 'busy' }, async () => console.log('ran')).then(
				() => console.log('taken'),
				(cause) => console.log(cause instanceof NothingChanged ? 'NothingChanged: ' + cause.message : 'other'),
			);
			`,
			'--',
			lock,
		],
		{ stdout: 'pipe', stderr: 'inherit' },
	);
	expect((await new Response(refused.stdout).text()).trim()).toBe(
		'NothingChanged: busy',
	);
	held.resolve();
	await holding;
});

test('work in one process takes turns on one lock, in order', async () => {
	const lock = join(BOX, 'turns.lock');
	const order: string[] = [];
	const first = Promise.withResolvers<void>();
	const one = holdingFileLock(lock, { waitMs: 0, held: 'busy' }, async () => {
		order.push('one starts');
		await first.promise;
		order.push('one ends');
	});
	const two = holdingFileLock(lock, { waitMs: 0, held: 'busy' }, async () => {
		order.push('two');
	});
	await Bun.sleep(20);
	first.resolve();
	await Promise.all([one, two]);
	expect(order).toEqual(['one starts', 'one ends', 'two']);
});

test('a link at the lock path is refused', async () => {
	const target = join(BOX, 'elsewhere.sqlite');
	writeFileSync(target, '');
	const lock = join(BOX, 'linked.lock');
	symlinkSync(target, lock);
	const taken = holdingFileLock(
		lock,
		{ waitMs: 0, held: 'busy' },
		async () => 'ran',
	);
	await expect(taken).rejects.toBeInstanceOf(NothingChanged);
});

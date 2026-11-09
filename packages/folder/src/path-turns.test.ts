/**
 * Path Turns Tests
 *
 * Key behaviors:
 * - Work on one path runs one at a time, in the order it was queued
 * - Work on another path runs beside it
 * - A path whose work has settled, thrown or not, leaves no entry behind
 */
import { expect, test } from 'bun:test';
import { createPathTurns } from './path-turns.js';

test('work on one path takes turns in order; another path runs beside it', async () => {
	const turns = createPathTurns();
	const events: string[] = [];
	const first = Promise.withResolvers<void>();
	const a1 = turns.run('a', async () => {
		events.push('a1 start');
		await first.promise;
		events.push('a1 end');
	});
	const a2 = turns.run('a', async () => {
		events.push('a2');
	});
	await turns.run('b', async () => {
		events.push('b');
	});
	expect(events).toEqual(['a1 start', 'b']);
	first.resolve();
	await Promise.all([a1, a2]);
	expect(events).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
});

test('a settled path leaves no entry, after a throw too', async () => {
	const turns = createPathTurns();
	const failed = turns.run('a', async () => {
		throw new Error('refused');
	});
	const after = turns.run('a', async () => 'ran');
	expect(turns.inUse()).toBe(1);
	await expect(failed).rejects.toThrow('refused');
	expect(await after).toBe('ran');
	expect(turns.inUse()).toBe(0);
	for (let index = 0; index < 100; index++)
		await turns.run(`path-${index}`, async () => {});
	expect(turns.inUse()).toBe(0);
});

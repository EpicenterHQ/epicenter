/**
 * Sync Git invocation tests.
 *
 * A round's command-line merge driver wins over stale local configuration
 * without changing the value plain Git reads between rounds.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config, git, withSyncDriver } from './git.ts';

const folder = mkdtempSync(join(tmpdir(), 'epicenter-sync-driver-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('sync Git calls override a stale local merge driver', async () => {
	expect((await git(folder, ['init', '-q'])).code).toBe(0);
	expect(
		(
			await git(folder, [
				'config',
				'--local',
				'merge.epicenter.driver',
				'old-driver',
			])
		).code,
	).toBe(0);
	const effective = await withSyncDriver(() =>
		git(folder, ['config', '--get', 'merge.epicenter.driver']),
	);
	expect(effective.code).toBe(0);
	expect(effective.stdout.trim()).toContain(`'${process.execPath}'`);
	expect(effective.stdout.trim()).toContain(
		`'${resolve(process.argv[1] as string)}' merge-driver %O %A %B %P`,
	);
	expect(await config(folder, 'merge.epicenter.driver')).toBe('old-driver');
});

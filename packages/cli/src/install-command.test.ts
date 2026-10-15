/**
 * `install-command` against a scratch directory instead of `/usr/local/bin`:
 * what each state of the target plans, that a dry run changes nothing, and
 * that a real run replaces a link in place.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminCommand, installCommand, planLink } from './install-command.ts';

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) {
		chmodSync(dir, 0o755);
		for (const child of ['bin', 'locked'])
			try {
				chmodSync(join(dir, child), 0o755);
			} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

function setup() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-install-')));
	scratch.push(dir);
	const binary = join(dir, 'Epicenter.app-epicenter-cli');
	writeFileSync(binary, '#!/bin/sh\n');
	mkdirSync(join(dir, 'bin'));
	return { dir, binary, target: join(dir, 'bin', 'epicenter') };
}

test('a missing target is linked, an existing link to the binary is unchanged, and a file is refused', () => {
	const { dir, binary, target } = setup();
	expect(planLink(binary, target)).toEqual({
		action: 'link',
		binary,
		target,
		needsAdmin: false,
	});
	symlinkSync(binary, target);
	expect(planLink(binary, target).action).toBe('unchanged');
	rmSync(target);
	symlinkSync(join(dir, 'old-epicenter'), target);
	expect(planLink(binary, target)).toMatchObject({
		action: 'link',
		replacing: join(dir, 'old-epicenter'),
	});
	rmSync(target);
	writeFileSync(target, 'someone else');
	expect(planLink(binary, target).action).toBe('refused');
});

test('a directory that is missing or not writable needs an administrator', () => {
	const { dir, binary } = setup();
	expect(planLink(binary, join(dir, 'absent', 'epicenter'))).toMatchObject({
		action: 'link',
		needsAdmin: true,
	});
	mkdirSync(join(dir, 'locked'));
	chmodSync(join(dir, 'locked'), 0o555);
	const target = join(dir, 'locked', 'epicenter');
	expect(planLink(binary, target)).toMatchObject({ needsAdmin: true });
	expect(adminCommand({ binary, target })).toBe(
		`sudo mkdir -p '${join(dir, 'locked')}' && sudo ln -sfn '${binary}' '${target}'`,
	);
});

test('a dry run changes nothing, and a run replaces the link in place', async () => {
	const { dir, binary, target } = setup();
	symlinkSync(join(dir, 'old-epicenter'), target);
	expect(
		await installCommand({ json: false, dryRun: true, binary, target }),
	).toBe(0);
	expect(readlinkSync(target)).toBe(join(dir, 'old-epicenter'));

	expect(
		await installCommand({ json: false, dryRun: false, binary, target }),
	).toBe(0);
	expect(lstatSync(target).isSymbolicLink()).toBe(true);
	expect(readlinkSync(target)).toBe(binary);
});

test('without an administrator and without a person to ask, it exits 1 and names the command', async () => {
	const { dir, binary } = setup();
	const target = join(dir, 'absent', 'epicenter');
	expect(
		await installCommand({
			json: true,
			dryRun: false,
			binary,
			target,
			interactive: false,
		}),
	).toBe(1);
	expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
});

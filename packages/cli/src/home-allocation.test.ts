/**
 * Records allocation uses the same filesystem cases as native home allocation.
 * Rejected destinations preserve configuration and existing files. Accepted
 * selections retain other homes and shortcuts and store the canonical path.
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import allocationCases from '../../tauri-plugin-epicenter-folder/fixtures/home-allocation.json';
import { epicenterDirectory } from './folders.js';

type AllocationCase = {
	name: string;
	data?: string;
	root: string;
	homes: Record<string, string>;
	directories?: string[];
	files?: string[];
	links?: Record<string, string>;
	allowed: boolean;
};

for (const scenario of allocationCases as AllocationCase[]) {
	test(scenario.name, async () => {
		const base = await realpath(
			await mkdtemp(join(tmpdir(), 'home-allocation-')),
		);
		try {
			const dataDir = join(base, scenario.data ?? 'machine');
			const folderDir = join(base, scenario.root);
			await mkdir(dataDir, { recursive: true });
			for (const directory of scenario.directories ?? [])
				await mkdir(join(base, directory), { recursive: true });
			for (const file of scenario.files ?? []) {
				await mkdir(dirname(join(base, file)), { recursive: true });
				await writeFile(join(base, file), 'keep');
			}
			for (const [alias, target] of Object.entries(scenario.links ?? {})) {
				await mkdir(dirname(join(base, alias)), { recursive: true });
				await symlink(join(base, target), join(base, alias), 'dir');
			}
			const homes = Object.fromEntries(
				Object.entries(scenario.homes).map(([key, path]) => [
					key,
					join(base, path),
				]),
			);
			const configPath = join(dataDir, 'folders.json');
			const original = JSON.stringify({ homes, folders: ['relative/keep'] });
			await writeFile(configPath, original);
			const candidate = homes.epicenter ?? join(folderDir, 'so.epicenter');
			const existed = existsSync(candidate);
			const paths = { dataDir, folderDir, commandLink: join(base, 'unused') };
			if (scenario.allowed) {
				expect(await epicenterDirectory(paths, false)).toBe(
					existed ? await realpath(candidate) : undefined,
				);
				expect(await readFile(configPath, 'utf8')).toBe(original);
				expect(existsSync(candidate)).toBe(existed);
				const selected = await epicenterDirectory(paths, true);
				expect(selected).toBe(await realpath(candidate));
				expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
					homes: { ...homes, epicenter: await realpath(candidate) },
					folders: ['relative/keep'],
				});
			} else {
				await expect(epicenterDirectory(paths, false)).rejects.toThrow();
				await expect(epicenterDirectory(paths, true)).rejects.toThrow();
				expect(await readFile(configPath, 'utf8')).toBe(original);
				expect(existsSync(candidate)).toBe(existed);
			}
			for (const file of scenario.files ?? [])
				expect(await readFile(join(base, file), 'utf8')).toBe('keep');
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
}

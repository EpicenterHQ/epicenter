/**
 * The records folder is admitted by the same filesystem cases as the native
 * `library::open_default(RECORDS)` (`records-default.json`). A noncreating
 * read makes nothing; a creating one makes or reuses `<root>/so.epicenter`.
 * Refused locations are left as they were, an earlier build's `folders.json`
 * changes nothing, and no configuration is written.
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fixture from '../../tauri-plugin-epicenter-folder/fixtures/records-default.json';
import { epicenterDirectory } from './folders.js';

type RecordsCase = {
	name: string;
	data?: string;
	root: string;
	directories?: string[];
	files?: string[];
	links?: Record<string, string>;
	allowed: boolean;
};

const present = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

for (const scenario of fixture.cases as RecordsCase[]) {
	test(scenario.name, async () => {
		const base = await realpath(
			await mkdtemp(join(tmpdir(), 'records-default-')),
		);
		try {
			const dataDir = join(base, scenario.data ?? 'machine');
			const folderDir = join(base, scenario.root);
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
			await mkdir(dataDir, { recursive: true });
			const legacy = join(dataDir, 'folders.json');
			await writeFile(legacy, fixture.legacyConfig);
			const candidate = join(folderDir, 'so.epicenter');
			const existed = await present(candidate);
			const rootExisted = existsSync(folderDir);
			const paths = { dataDir, folderDir, commandLink: join(base, 'unused') };
			if (scenario.allowed) {
				expect(await epicenterDirectory(paths, false)).toBe(
					existed ? await realpath(candidate) : undefined,
				);
				expect(await present(candidate)).toBe(existed);
				expect(existsSync(folderDir)).toBe(rootExisted);
				expect(await epicenterDirectory(paths, true)).toBe(
					await realpath(candidate),
				);
			} else {
				await expect(epicenterDirectory(paths, false)).rejects.toThrow();
				await expect(epicenterDirectory(paths, true)).rejects.toThrow();
				expect(await present(candidate)).toBe(existed);
			}
			expect(await readdir(dataDir)).toEqual(['folders.json']);
			expect(await readFile(legacy, 'utf8')).toBe(fixture.legacyConfig);
			for (const file of scenario.files ?? [])
				expect(await readFile(join(base, file), 'utf8')).toBe('keep');
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
}

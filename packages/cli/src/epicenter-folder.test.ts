/**
 * Epicenter's own folder, `so.epicenter` (ADR-0539), and the declaration the
 * desktop app publishes at every launch.
 *
 * Key behaviors:
 * - Each AI connection is a row `connections/<id>.md` holding its kind,
 *   title, and model, never an endpoint or key; an app's definition reads it
 * - `declare-epicenter-folder` makes the folder and publishes its
 *   declaration, so a definition reading a table an update added fits
 *   before anything else writes the folder; publishing again changes no byte
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CONNECTIONS_FOLDER_ID,
	connectionsDefinition,
} from '@epicenter/ai/connection-table';
import { openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { resolveAppPaths } from './app-paths.ts';
import {
	declareEpicenterFolder,
	epicenterDefinition,
} from './epicenter-folder.ts';

const author = { name: 'Epicenter', email: 'epicenter@localhost' };
const originalEnv = { ...process.env };
const scratch: string[] = [];
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(async () => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	await Promise.all(scratch.map((dir) => rm(dir, { recursive: true })));
});

/** A scratch Epicenter folder root, and `so.epicenter`'s path under it. */
async function folderRoot() {
	const dir = await mkdtemp(join(tmpdir(), 'epicenter-folder-'));
	scratch.push(dir);
	const paths = resolveAppPaths({
		EPICENTER_FOLDER_DIR: dir,
		EPICENTER_DATA_DIR: join(dir, '.data'),
		EPICENTER_CACHE_DIR: join(dir, '.cache'),
	});
	return { paths, root: join(dir, CONNECTIONS_FOLDER_ID) };
}

test('an AI connection is a row of kind, title, and model, which an app reads through its definition', async () => {
	const { paths, root } = await folderRoot();
	expect(await declareEpicenterFolder(false, paths)).toBe(0);
	const folder = expectOk(
		await openFolder({
			root,
			definition: epicenterDefinition,
			git: { author },
		}),
	);
	try {
		expectOk(
			await folder.tables.connections.create(
				{
					fields: {
						kind: 'openai-compatible',
						title: 'Groq',
						model: 'whisper-large-v3',
					},
					body: '',
				},
				{ stem: 'groq' },
			),
		);
		const text = await readFile(join(root, 'connections/groq.md'), 'utf8');
		expect(text).toContain('kind: openai-compatible');
		expect(text).toContain('model: whisper-large-v3');
		expect(text).not.toContain('endpoint');

		const reader = expectOk(
			await openFolder({
				root,
				definition: connectionsDefinition,
				git: { author },
			}),
		);
		try {
			const row = expectOk(await reader.tables.connections.get('groq'));
			expect(row?.row.fields).toEqual({
				kind: 'openai-compatible',
				title: 'Groq',
				model: 'whisper-large-v3',
			});
		} finally {
			await reader.close();
		}
	} finally {
		await folder.close();
	}
});

test('declaring publishes the definition, so a definition reading a table an update added fits', async () => {
	const { paths, root } = await folderRoot();
	expect(await declareEpicenterFolder(false, paths)).toBe(0);
	const path = join(root, 'epicenter.json');
	const current = await readFile(path, 'utf8');

	// The declaration an Epicenter before `connections` published.
	const earlier = JSON.parse(current);
	delete earlier.tables.connections;
	await writeFile(path, JSON.stringify(earlier));
	const refused = await openFolder({
		root,
		definition: connectionsDefinition,
		git: { author },
	});
	expect(refused.error?.name).toBe('DefinitionMismatch');

	// The next launch publishes it again, before anything else writes.
	expect(await declareEpicenterFolder(false, paths)).toBe(0);
	expect(await readFile(path, 'utf8')).toBe(current);
	const reader = expectOk(
		await openFolder({
			root,
			definition: connectionsDefinition,
			git: { author },
		}),
	);
	try {
		expect(expectOk(await reader.tables.connections.list())).toEqual([]);
	} finally {
		await reader.close();
	}
});

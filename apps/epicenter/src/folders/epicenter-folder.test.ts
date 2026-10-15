/**
 * Epicenter's own folder, `so.epicenter` (ADR-0539).
 *
 * Key behaviors:
 * - Each installed app that runs is a row `apps/<app-id>.md` with its title,
 *   source, folder, and commit
 * - An app waiting for approval, or broken, gets no row
 * - A row that already says the same is left as it is; a changed one keeps
 *   the body and any field a person added
 * - `defaultApp` holds a folder id to app id record
 * - Each AI connection is a row `connections/<id>.md` holding its kind,
 *   title, and model, never an endpoint or key; an app's lens reads it
 * - Opening the Folders window publishes the declaration, so a lens on a
 *   table an update added fits before anything else writes the folder
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionsLens } from '@epicenter/ai/connection-table';
import type { InstalledApp } from '@epicenter/cli';
import { openDataFolder, openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { declare, epicenterDefinition, writeAppRows } from './epicenter-folder';

const author = { name: 'Epicenter', email: 'epicenter@localhost' };
const originalEnv = { ...process.env };
const roots: string[] = [];
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
	await Promise.all(roots.map((root) => rm(root, { recursive: true })));
});

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'so-epicenter-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition: epicenterDefinition,
			git: { author },
		}),
	);
	return { root, folder };
}

function app(overrides: Partial<InstalledApp> = {}): InstalledApp {
	return {
		id: 'com.example.board',
		title: 'Board',
		source: 'https://example.com/board.git',
		folder: 'apps/board',
		commit: 'a'.repeat(40),
		state: { kind: 'ready' },
		...overrides,
	};
}

test('an installed app that runs is a row named by its id', async () => {
	const { root, folder } = await open();
	try {
		const review = { from: null, log: '', diffStat: '', statement: '' };
		expect(
			await writeAppRows(folder, [
				app(),
				app({
					id: 'com.example.pending',
					state: { kind: 'needsApproval', review },
				}),
				app({
					id: 'com.example.broken',
					state: { kind: 'broken', problem: 'x' },
				}),
			]),
		).toBeUndefined();
		const listed = expectOk(await folder.tables.apps.list());
		expect(listed.map(({ stem }) => stem)).toEqual(['com.example.board']);
		const text = await readFile(
			join(root, 'apps/com.example.board.md'),
			'utf8',
		);
		expect(text).toContain('title: Board');
		expect(text).toContain('source: "https://example.com/board.git"');
		expect(text).toContain('folder: apps/board');
		expect(text).toContain(`commit: ${'a'.repeat(40)}`);
	} finally {
		await folder.close();
	}
});

test('a changed app updates its row and keeps what a person added', async () => {
	const { root, folder } = await open();
	try {
		await writeAppRows(folder, [app()]);
		const path = join(root, 'apps/com.example.board.md');
		const original = await readFile(path, 'utf8');
		await writeFile(path, `${original}My board for planning.\n`);
		// The same facts leave the file alone.
		await writeAppRows(folder, [app()]);
		expect(await readFile(path, 'utf8')).toContain('My board for planning.');

		await writeAppRows(folder, [app({ commit: 'b'.repeat(40) })]);
		const text = await readFile(path, 'utf8');
		expect(text).toContain(`commit: ${'b'.repeat(40)}`);
		expect(text).toContain('My board for planning.');
	} finally {
		await folder.close();
	}
});

test('defaultApp records the app each folder opens in', async () => {
	const { folder } = await open();
	try {
		expectOk(
			await folder.kv.set('defaultApp', { 'data:notes': 'com.example.board' }),
		);
		expect(expectOk(await folder.kv.get())?.values.defaultApp).toEqual({
			'data:notes': 'com.example.board',
		});
	} finally {
		await folder.close();
	}
});

test('an AI connection is a row of kind, title, and model, which an app reads through its lens', async () => {
	const { root, folder } = await open();
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
		expectOk(
			await folder.tables.connections.update('groq', {
				set: { model: 'whisper-large-v3-turbo' },
			}),
		);

		const lens = expectOk(
			await openDataFolder({ root, lens: connectionsLens, git: { author } }),
		);
		try {
			const row = expectOk(await lens.tables.connections.get('groq'));
			expect(row?.row.fields).toEqual({
				kind: 'openai-compatible',
				title: 'Groq',
				model: 'whisper-large-v3-turbo',
			});
		} finally {
			await lens.close();
		}
	} finally {
		await folder.close();
	}
});

test('declaring publishes the definition, so a lens on a table an update added fits', async () => {
	const { root, folder } = await open();
	const path = join(root, 'epicenter.json');
	try {
		expect(await declare(folder)).toBeUndefined();
	} finally {
		await folder.close();
	}
	const current = await readFile(path, 'utf8');

	// The declaration an Epicenter before `connections` published.
	const earlier = JSON.parse(current);
	delete earlier.tables.connections;
	await writeFile(path, JSON.stringify(earlier));
	const refused = await openDataFolder({
		root,
		lens: connectionsLens,
		git: { author },
	});
	expect(refused.error?.name).toBe('ShapeMismatch');

	// The next launch's handle publishes it again, before anything else writes.
	const next = expectOk(
		await openFolder({
			root,
			definition: epicenterDefinition,
			git: { author },
		}),
	);
	try {
		expect(await declare(next)).toBeUndefined();
	} finally {
		await next.close();
	}
	expect(await readFile(path, 'utf8')).toBe(current);
	const lens = expectOk(
		await openDataFolder({ root, lens: connectionsLens, git: { author } }),
	);
	try {
		expect(expectOk(await lens.tables.connections.list())).toEqual([]);
	} finally {
		await lens.close();
	}
});

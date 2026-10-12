/**
 * Legacy Export and Import Tests
 *
 * Exports the old Personal store from a real in-memory store, and imports
 * bundles into a real native folder in a temporary directory. File contents
 * are compared with literal Markdown.
 *
 * Key behaviors:
 * - Exporting reads rows, bodies, and nonconforming rows and writes nothing
 * - A capture becomes one document: its text, then its thoughts by position
 * - Entries keep their own timestamp and parent ID; orphan thoughts get a
 *   labelled export-time date and name the capture they lost
 * - A body that could not be read is reported apart from an empty one, and
 *   is neither imported nor recorded
 * - Retry: a receipted source is skipped even after its file is deleted, an
 *   absent destination is created, one holding the same capture is recorded
 *   (in whatever frontmatter style an earlier version wrote), and one
 *   holding another capture is reported and left alone
 * - A receipt that could not be written leaves a run that a retry completes
 * - Thoughts arriving after their capture was imported become a separate
 *   document; the imported capture is not patched
 * - Each account has its own receipt and file names
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemory } from '@epicenter/app/memory';
import { openFolder } from '@epicenter/folder/bun';
import * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { captureBody, captureDefinition } from '../index.js';
import {
	exportLegacyBundle,
	type ImportFiles,
	type LegacyBundle,
	legacyCaptureDefinition,
	planLegacyImport,
	readLegacyBundle,
	runLegacyImport,
	serializeLegacyBundle,
} from './index.js';

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'capture-legacy-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition: captureDefinition,
			git: { author: { name: 'Test', email: 'test@localhost' } },
		}),
	);
	const captureFiles = async () =>
		expectOk(await folder.files.list())
			.files.filter(({ path }) => path.startsWith('captures/'))
			.map(({ path }) => path.slice('captures/'.length))
			.sort();
	return {
		root,
		folder,
		captureFiles,
		text: (path: string) => readFile(join(root, path), 'utf8'),
	};
}

const ACCOUNT = { authorityId: 'authority-a', principalId: 'principal-a' };

function bundleOf(partial: Partial<LegacyBundle>): LegacyBundle {
	return {
		format: 'epicenter.capture.legacy-bundle',
		version: 1,
		exportedAt: '2026-10-01T02:30:00.000Z',
		source: {
			storeId: 'so.epicenter.capture',
			account: ACCOUNT,
			scope: 'local-replica',
		},
		captures: [],
		thoughts: [],
		entries: [],
		unreadable: [],
		promotionCount: 0,
		...partial,
	};
}

const DINNER = bundleOf({
	captures: [
		{
			id: 'c1',
			capturedAt: '2026-01-01T00:00:00.000Z',
			text: '  Dinner\nFriday  \n',
		},
	],
	thoughts: [
		{ id: 't2', captureId: 'c1', position: 1, text: 'second\nline two' },
		{ id: 't1', captureId: 'c1', position: 0, text: 'first' },
		{ id: 't3', captureId: 'c1', position: 2, text: '' },
	],
});

function bodyFrom(text: string): Y.Node {
	const body = new Y.Node();
	if (text) body.applyDelta(body.change.insert(text) as never);
	return body;
}

// ============================================================================
// Export
// ============================================================================

test('export carries rows, bodies, and unreadable rows, and leaves the store as it was', async () => {
	await using data = await openMemory(legacyCaptureDefinition);
	const capturedAt = '2026-01-01T00:00:00.000Z' as never;
	const capture = data.tables.captures.create({ capturedAt }, bodyFrom('Root'));
	const thought = data.tables.thoughts.create(
		{ captureId: capture.id, position: 0 },
		bodyFrom('A thought'),
	);
	const broken = data.tables.thoughts.create(
		{ captureId: capture.id, position: 1 },
		bodyFrom('Still readable text'),
	);
	data.tables.thoughts.update(broken.id, { position: 'broken' } as never);
	const entry = data.tables.entries.create(
		{ parentId: null, capturedAt },
		bodyFrom('Earlier'),
	);
	data.tables.promotions.create({ requestId: 'r', captureId: null });
	const rowsBefore = JSON.stringify([
		data.tables.captures.rows,
		data.tables.thoughts.rows,
		data.tables.entries.rows,
	]);

	const bundle = exportLegacyBundle(data, {
		exportedAt: '2026-10-01T02:30:00.000Z',
		account: ACCOUNT,
	});

	expect(bundle.captures).toEqual([
		{ id: capture.id, capturedAt: '2026-01-01T00:00:00.000Z', text: 'Root' },
	]);
	expect(bundle.thoughts).toEqual([
		{ id: thought.id, captureId: capture.id, position: 0, text: 'A thought' },
	]);
	expect(bundle.entries).toEqual([
		{
			id: entry.id,
			parentId: null,
			capturedAt: '2026-01-01T00:00:00.000Z',
			text: 'Earlier',
		},
	]);
	expect(bundle.unreadable).toHaveLength(1);
	expect(bundle.unreadable[0]).toMatchObject({
		table: 'thoughts',
		id: broken.id,
		text: 'Still readable text',
	});
	expect(bundle.promotionCount).toBe(1);
	expect(
		JSON.stringify([
			data.tables.captures.rows,
			data.tables.thoughts.rows,
			data.tables.entries.rows,
		]),
	).toBe(rowsBefore);

	const reread = readLegacyBundle(JSON.parse(serializeLegacyBundle(bundle)));
	expect(reread.ok && reread.bundle).toEqual(bundle);
});

test('a file that is not a bundle is refused whole, naming each problem', () => {
	const result = readLegacyBundle({
		format: 'something-else',
		version: 1,
		captures: [{ id: 'c1' }],
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.problems).toContain(
		'"format" is not "epicenter.capture.legacy-bundle".',
	);
	expect(result.problems).toContain(
		'captures[0] has no capturedAt date and time.',
	);
	expect(result.problems).toContain('"thoughts" is not a list.');
});

// ============================================================================
// Documents
// ============================================================================

test('a capture imports as its exact text and its thoughts in position order', async () => {
	const { folder, captureFiles, text } = await setup();
	const report = await runLegacyImport(folder.files, DINNER);

	expect(report.complete).toBe(true);
	expect(report.documents.map((item) => item.status)).toEqual(['created']);
	const [file] = await captureFiles();
	expect(await text(`captures/${file}`)).toBe(
		'---\ncapturedAt: "2026-01-01T00:00:00.000Z"\nimportedFrom: so.epicenter.capture/captures/c1\n---\n\n  Dinner\nFriday  \n\n\n## Thoughts\n\n- first\n- second\n  line two\n',
	);
	expect(report.diagnostics.emptyThoughts).toEqual(['t3']);

	// The folder's table reads it as a valid capture.
	const listed = expectOk(await folder.tables.captures.list());
	expect(listed).toHaveLength(1);
	const entry = expectOk(listed[0]!.result);
	expect(String(entry.row.fields.capturedAt)).toBe('2026-01-01T00:00:00.000Z');
	const body = expectOk(captureBody.decode(entry.row.body));
	expect(body.text).toBe('  Dinner\nFriday  \n');
	expect(body.thoughts).toEqual(['first', 'second\nline two']);
	await folder.close();
});

test('entries keep their timestamp and parent; orphans get a labelled export date', async () => {
	const { folder, captureFiles, text } = await setup();
	const report = await runLegacyImport(
		folder.files,
		bundleOf({
			thoughts: [
				{ id: 'o2', captureId: 'gone', position: 5, text: 'later' },
				{ id: 'o1', captureId: 'gone', position: 1, text: 'earlier' },
			],
			entries: [
				{
					id: 'e2',
					parentId: 'e1',
					capturedAt: '2025-06-01T08:00:00.000Z',
					text: 'Child entry',
				},
			],
		}),
	);
	expect(report.documents.map((item) => item.kind).sort()).toEqual([
		'entry',
		'orphan-thoughts',
	]);
	const files = await captureFiles();
	const entry = files.find((name) => name.includes('-e-')) ?? '';
	const orphan = files.find((name) => name.includes('-o-')) ?? '';
	expect(await text(`captures/${entry}`)).toBe(
		'---\ncapturedAt: "2025-06-01T08:00:00.000Z"\nimportedFrom: so.epicenter.capture/entries/e2\nlegacyParentId: e1\n---\n\nChild entry\n\n## Thoughts\n',
	);
	expect(await text(`captures/${orphan}`)).toBe(
		'---\ncapturedAt: "2026-10-01T02:30:00.000Z"\ncapturedAtIs: export time, not when these were written\nimportedFrom: so.epicenter.capture/orphans/gone\n---\n\nRecovered thoughts without their capture.\n\nThe capture they belong to (old ID `gone`) was not in the export, so its text and date are unknown. The date above is when the export was made, not when these were written.\n\nOld thought IDs, in order: o1, o2\n\n## Thoughts\n\n- earlier\n- later\n',
	);
	await folder.close();
});

test('an unreadable body is reported apart from an empty one and is not recorded', async () => {
	const { folder, captureFiles, text } = await setup();
	const lazy = bundleOf({
		captures: [
			{ id: 'lazy', capturedAt: '2026-01-01T00:00:00.000Z', text: null },
			{ id: 'empty', capturedAt: '2026-01-02T00:00:00.000Z', text: '' },
		],
		thoughts: [
			{
				id: 'held',
				captureId: 'lazy',
				position: 0,
				text: 'kept in the report',
			},
		],
		unreadable: [
			{
				table: 'entries',
				id: 'bad',
				raw: { capturedAt: 7 },
				issues: ['capturedAt'],
				text: 'entry ``` text',
			},
		],
		promotionCount: 2,
	});
	const report = await runLegacyImport(folder.files, lazy);

	expect(report.documents.map((item) => item.identity)).toEqual([
		'captures/empty',
	]);
	expect(report.diagnostics.unreadableBodies).toEqual([
		{ table: 'captures', id: 'lazy' },
	]);
	expect(report.diagnostics.heldThoughts).toEqual(['held']);
	expect(await captureFiles()).toHaveLength(1);
	const markdown = await text(report.reportPath);
	expect(markdown).toContain('- captures/lazy');
	expect(markdown).toContain('kept in the report');
	expect(markdown).toContain('````\nentry ``` text\n````');
	expect(markdown).toContain('"capturedAt": 7');
	const receipt = JSON.parse(await text(report.receiptPath));
	expect(Object.keys(receipt.imports)).toEqual(['captures/empty']);

	// The body arrives in a later export: the capture is imported then, whole.
	const later = await runLegacyImport(
		folder.files,
		bundleOf({
			...lazy,
			exportedAt: '2026-10-02T00:00:00.000Z',
			captures: [
				{
					id: 'lazy',
					capturedAt: '2026-01-01T00:00:00.000Z',
					text: 'Loaded now',
				},
				{ id: 'empty', capturedAt: '2026-01-02T00:00:00.000Z', text: '' },
			],
		}),
	);
	expect(later.alreadyImported).toEqual(['captures/empty']);
	expect(later.documents.map((item) => [item.identity, item.status])).toEqual([
		['captures/lazy', 'created'],
	]);
	await folder.close();
});

// ============================================================================
// Retry
// ============================================================================

test('a receipted source is skipped on retry, even after its file was deleted', async () => {
	const { root, folder, captureFiles } = await setup();
	const first = await runLegacyImport(folder.files, DINNER);
	const [file] = await captureFiles();
	await rm(join(root, 'captures', file ?? ''));

	const retry = await runLegacyImport(folder.files, DINNER);
	expect(first.bundleId).toBe(retry.bundleId);
	expect(retry.alreadyImported).toEqual(['captures/c1']);
	expect(retry.documents).toEqual([]);
	expect(retry.receipt.status).toBe('unchanged');
	expect(await captureFiles()).toEqual([]);
	await folder.close();
});

test('an edited imported file is left alone on retry', async () => {
	const { root, folder, captureFiles } = await setup();
	await runLegacyImport(folder.files, DINNER);
	const [file] = await captureFiles();
	await writeFile(join(root, 'captures', file ?? ''), 'my edits');
	const retry = await runLegacyImport(folder.files, DINNER);
	expect(retry.documents).toEqual([]);
	expect(await readFile(join(root, 'captures', file ?? ''), 'utf8')).toBe(
		'my edits',
	);
	await folder.close();
});

test('a failed receipt is reported, and the retry records the identical files', async () => {
	const { folder, captureFiles, text } = await setup();
	let failReceipt = true;
	const files: ImportFiles = {
		read: folder.files.read,
		create: async (path, content) => {
			if (failReceipt && path.includes('receipt'))
				throw new Error('disk went away');
			return folder.files.create(path, content);
		},
		replace: folder.files.replace,
	};
	const partial = await runLegacyImport(files, DINNER);
	expect(partial.documents.map((item) => item.status)).toEqual(['created']);
	expect(partial.receipt).toEqual({
		status: 'failed',
		message: 'disk went away',
	});
	expect(partial.complete).toBe(false);

	failReceipt = false;
	const retry = await runLegacyImport(files, DINNER);
	expect(retry.documents.map((item) => item.status)).toEqual(['identical']);
	expect(retry.receipt.status).toBe('written');
	expect(retry.complete).toBe(true);
	expect(await captureFiles()).toHaveLength(1);
	expect(
		Object.keys(JSON.parse(await text(retry.receiptPath)).imports),
	).toEqual(['captures/c1']);
	await folder.close();
});

test('a destination holding another capture is reported, left alone, and not recorded', async () => {
	const { folder, text } = await setup();
	const plan = await planLegacyImport(DINNER, undefined);
	const document = plan.documents[0];
	if (document === undefined) throw new Error('fixture');
	const destination = document.path;
	const changed = document.source.replace('Dinner', 'Lunch');
	expectOk(await folder.files.create(destination, changed));

	const report = await runLegacyImport(folder.files, DINNER);
	expect(report.documents.map((item) => item.status)).toEqual(['differs']);
	expect(report.complete).toBe(false);
	expect(report.receipt.status).toBe('unchanged');
	expect(await text(destination)).toBe(changed);
	expect(expectErr(await folder.files.read(report.receiptPath)).name).toBe(
		'NotFound',
	);
	await folder.close();
});

test('a destination an earlier version wrote in another frontmatter style is the same capture, and is recorded', async () => {
	const { folder, text } = await setup();
	const plan = await planLegacyImport(DINNER, undefined);
	const document = plan.documents[0];
	if (document === undefined) throw new Error('fixture');
	// JSON-style frontmatter and a byte-order mark: other bytes, the same row.
	const earlier = `\uFEFF${document.source
		.replace(
			'capturedAt: "2026-01-01T00:00:00.000Z"',
			'"capturedAt": "2026-01-01T00:00:00.000Z"',
		)
		.replace(
			'importedFrom: so.epicenter.capture/captures/c1',
			'"importedFrom": "so.epicenter.capture/captures/c1"',
		)}`;
	expect(earlier).not.toBe(document.source);
	expectOk(await folder.files.create(document.path, earlier));

	const report = await runLegacyImport(folder.files, DINNER);
	expect(report.documents.map((item) => item.status)).toEqual(['identical']);
	expect(report.complete).toBe(true);
	expect(report.receipt.status).toBe('written');
	// Recorded, and left exactly as it was.
	expect(await text(document.path)).toBe(earlier);
	const again = await runLegacyImport(folder.files, DINNER);
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toEqual([document.identity]);
	await folder.close();
});

test('an unreadable receipt stops the import before anything is written', async () => {
	const { folder, captureFiles } = await setup();
	const plan = await planLegacyImport(DINNER, undefined);
	await folder.files.create(plan.receiptPath, '{ not json');
	await expect(runLegacyImport(folder.files, DINNER)).rejects.toThrow(
		'Nothing was imported',
	);
	expect(await captureFiles()).toEqual([]);
	expect(expectErr(await folder.files.read(plan.bundlePath)).name).toBe(
		'NotFound',
	);
	await folder.close();
});

for (const [name, imports] of [
	[
		'an imports array',
		[
			{
				path: 'captures/one.md',
				sha256: 'a'.repeat(64),
				bundleId: 'b'.repeat(16),
				thoughtIds: ['t1'],
			},
		],
	],
	[
		'an invalid hash',
		{
			'captures/c1': {
				path: 'captures/one.md',
				sha256: 'invalid',
				bundleId: 'b'.repeat(16),
				thoughtIds: ['t1'],
			},
		},
	],
	[
		'a non-string thought ID',
		{
			'captures/c1': {
				path: 'captures/one.md',
				sha256: 'a'.repeat(64),
				bundleId: 'b'.repeat(16),
				thoughtIds: [1],
			},
		},
	],
] as const) {
	test(`${name} stops import before any capture or bundle is written`, async () => {
		const { folder, captureFiles } = await setup();
		try {
			const plan = await planLegacyImport(DINNER, undefined);
			const written = await folder.files.create(
				plan.receiptPath,
				JSON.stringify({
					format: 'epicenter.capture.legacy-import-receipt',
					version: 1,
					account: ACCOUNT,
					imports,
				}),
			);
			expectOk(written);
			await expect(runLegacyImport(folder.files, DINNER)).rejects.toThrow(
				'Nothing was imported',
			);
			expect(await captureFiles()).toEqual([]);
			expect(expectErr(await folder.files.read(plan.bundlePath)).name).toBe(
				'NotFound',
			);
		} finally {
			await folder.close();
		}
	});
}

test('thoughts arriving after their capture was imported become a separate document', async () => {
	const { folder, captureFiles, text } = await setup();
	await runLegacyImport(folder.files, DINNER);
	const [original] = await captureFiles();
	const before = await text(`captures/${original}`);

	const later = bundleOf({
		...DINNER,
		exportedAt: '2026-10-05T00:00:00.000Z',
		thoughts: [
			...DINNER.thoughts,
			{ id: 't9', captureId: 'c1', position: 9, text: 'arrived late' },
		],
	});
	const report = await runLegacyImport(folder.files, later);
	expect(report.alreadyImported).toEqual(['captures/c1']);
	expect(report.documents.map((item) => [item.kind, item.status])).toEqual([
		['late-thoughts', 'created'],
	]);
	expect(await text(`captures/${original}`)).toBe(before);
	const late = await text(report.documents[0]?.path ?? '');
	expect(late).toContain(
		`imported as \`captures/${original}\` (old ID \`c1\`)`,
	);
	expect(late.endsWith('## Thoughts\n\n- arrived late\n')).toBe(true);

	const again = await runLegacyImport(folder.files, later);
	expect(again.documents).toEqual([]);
	expect(await captureFiles()).toHaveLength(2);
	await folder.close();
});

test('two accounts importing the same rows keep separate files and receipts', async () => {
	const { folder, captureFiles } = await setup();
	const first = await runLegacyImport(folder.files, DINNER);
	const second = await runLegacyImport(
		folder.files,
		bundleOf({
			...DINNER,
			source: {
				...DINNER.source,
				account: { authorityId: 'authority-a', principalId: 'principal-b' },
			},
		}),
	);
	expect(second.documents.map((item) => item.status)).toEqual(['created']);
	expect(second.receiptPath).not.toBe(first.receiptPath);
	expect(await captureFiles()).toHaveLength(2);
	await folder.close();
});

test('text that absorbs the section is still written whole and is flagged', async () => {
	const { folder, text } = await setup();
	const report = await runLegacyImport(
		folder.files,
		bundleOf({
			captures: [
				{
					id: 'c1',
					capturedAt: '2026-01-01T00:00:00.000Z',
					text: '```\nopen fence',
				},
			],
			thoughts: [{ id: 't1', captureId: 'c1', position: 0, text: 'a thought' }],
		}),
	);
	const [document] = report.documents;
	expect(document?.structured?.code).toBe('unverified');
	expect(await text(document?.path ?? '')).toContain(
		'```\nopen fence\n\n## Thoughts\n\n- a thought\n',
	);
	await folder.close();
});

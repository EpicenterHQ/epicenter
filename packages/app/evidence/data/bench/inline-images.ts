/**
 * Comparison only: inline images are excluded from the proposed product.
 * Run from the repository root: bun packages/app/evidence/data/bench/inline-images.ts
 *
 * Synthetic compressed-image-sized random payloads, not an image codec or UI
 * benchmark. Each case has its own builder process and three fresh reader
 * processes. Measures raw Yjs V2 snapshots, hydration, and one title edit.
 * Excludes transport compression, network, SQLite, projections, and rendering.
 */
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from '@y/y';
import { asValues, putRow, rowAt } from '../raw-document.js';

const IMAGE_BYTES = 100 * 1024;
const BODY = 'A short sentence in an ordinary note. '.repeat(75);
const [phase, directory, mode, countText] = Bun.argv.slice(2);
const count = Number(countText);
const rowId = (index: number) => `note-${String(index).padStart(6, '0')}`;
const url = (index: number) =>
	`https://cloud.example/api/blobs/blob_${String(index).padStart(21, '0')}`;

if (phase === 'build') {
	assert.ok(directory, 'The build phase requires a scratch directory');
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('tables:notes');
	let sample = '';
	doc.transact(() => {
		for (let index = 0; index < count; index++) {
			const row = asValues(new Y.Node());
			putRow(root, rowId(index), row);
			row.setAttr('title', `Note ${index}`);
			row.setAttr('body', BODY);
			const image =
				mode === 'inline'
					? `data:image/webp;base64,${randomFillSync(Buffer.alloc(IMAGE_BYTES)).toString('base64')}`
					: url(index);
			row.setAttr('image', image);
			if (index === count - 1) sample = image;
		}
	});
	const start = performance.now();
	const snapshot = Y.encodeStateAsUpdateV2(doc);
	const encodeMs = performance.now() - start;
	await Bun.write(join(directory, 'snapshot.bin'), snapshot);
	await Bun.write(join(directory, 'sample.txt'), sample);
	console.log(JSON.stringify({ snapshotBytes: snapshot.byteLength, encodeMs }));
	doc.destroy();
} else if (phase === 'read') {
	assert.ok(directory, 'The read phase requires a scratch directory');
	const bytes = new Uint8Array(
		await Bun.file(join(directory, 'snapshot.bin')).arrayBuffer(),
	);
	const sample = await Bun.file(join(directory, 'sample.txt')).text();
	Bun.gc(true);
	const baseline = process.memoryUsage();
	const doc = new Y.Doc({ gc: true });
	const start = performance.now();
	Y.applyUpdateV2(doc, bytes);
	const hydrateMs = performance.now() - start;
	const root = doc.get('tables:notes');
	assert.equal(Object.keys(root.getAttrs()).length, count);
	assert.equal(rowAt(root, rowId(count - 1))?.getAttr('image'), sample);
	assert.equal(rowAt(root, rowId(0))?.getAttr('body'), BODY);
	Bun.gc(true);
	const loaded = process.memoryUsage();
	const vector = Y.encodeStateVector(doc);
	rowAt(root, rowId(0))!.setAttr('title', 'Edited title');
	const titleDelta = Y.encodeStateAsUpdateV2(doc, vector);
	// Control: the small delta must change a replica while preserving its image.
	const peer = new Y.Doc({ gc: true });
	Y.applyUpdateV2(peer, bytes);
	Y.applyUpdateV2(peer, titleDelta);
	assert.equal(
		rowAt(peer.get('tables:notes'), rowId(0))?.getAttr('title'),
		'Edited title',
	);
	assert.equal(
		rowAt(peer.get('tables:notes'), rowId(0))?.getAttr('image'),
		rowAt(root, rowId(0))?.getAttr('image'),
	);
	assert.equal(
		rowAt(peer.get('tables:notes'), rowId(count - 1))?.getAttr('image'),
		sample,
	);
	peer.destroy();
	doc.transact(() => {
		for (let index = 0; index < count; index++)
			rowAt(root, rowId(index))!.deleteAttr('image');
	});
	const afterImageDeletion = Y.encodeStateAsUpdateV2(doc);
	const cleaned = new Y.Doc({ gc: true });
	Y.applyUpdateV2(cleaned, afterImageDeletion);
	const cleanedRoot = cleaned.get('tables:notes');
	assert.equal(Object.keys(cleanedRoot.getAttrs()).length, count);
	assert.equal(rowAt(cleanedRoot, rowId(0))?.getAttr('title'), 'Edited title');
	for (let index = 0; index < count; index++) {
		assert.equal(rowAt(cleanedRoot, rowId(index))?.getAttr('image'), undefined);
		assert.equal(rowAt(cleanedRoot, rowId(index))?.getAttr('body'), BODY);
	}
	cleaned.destroy();
	console.log(
		JSON.stringify({
			hydrateMs,
			rssDeltaBytes: loaded.rss - baseline.rss,
			titleDeltaBytes: titleDelta.byteLength,
			snapshotAfterImageDeletionBytes: afterImageDeletion.byteLength,
		}),
	);
	doc.destroy();
} else {
	const scratch = await mkdtemp(join(tmpdir(), 'epicenter-inline-images-'));
	const results = [];
	async function child(childPhase: string, childMode: string, rows: number) {
		const process = Bun.spawn(
			[
				Bun.which('bun')!,
				import.meta.path,
				childPhase,
				scratch,
				childMode,
				String(rows),
			],
			{
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [output, errors, exit] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		assert.equal(exit, 0, errors);
		return JSON.parse(output);
	}
	try {
		for (const rows of [100, 1000]) {
			for (const childMode of ['url', 'inline']) {
				const built = await child('build', childMode, rows);
				const readers = [];
				for (let trial = 0; trial < 3; trial++)
					readers.push(await child('read', childMode, rows));
				results.push({
					mode: childMode,
					rows,
					imageBytes: IMAGE_BYTES,
					...built,
					readers,
				});
			}
		}
		// An empty update must not satisfy the positive corpus controls.
		const empty = new Y.Doc();
		assert.notEqual(
			Object.keys(empty.get('tables:notes').getAttrs()).length,
			100,
		);
		empty.destroy();
		console.log(
			JSON.stringify(
				{
					date: new Date().toISOString(),
					bun: Bun.version,
					yjs: (await import('@y/y/package.json')).default.version,
					platform: process.platform,
					architecture: process.arch,
					bodyCharacters: BODY.length,
					method:
						'Synthetic image payload as a row value; fresh processes; raw V2 bytes; three hydration trials. No image decoding, transport compression, disk persistence timing, projection, or editor rendering.',
					results,
				},
				null,
				2,
			),
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Run with bun run --filter @epicenter/app bench. Each cold-open sample uses a fresh process. */

import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from '@y/y';
import { deleteRow } from '../store/document.js';
import {
	encode,
	put,
	reconstruct,
	reopen,
	rows,
	seed,
} from './root-rotation.fixture.js';

const packageInfo = await Bun.file(
	new URL('../../../node_modules/@y/y/package.json', import.meta.url),
).json();
if (packageInfo.name !== '@y/y' || packageInfo.version !== '14.0.0-rc.26') {
	throw new Error(
		'Revalidate this experiment when changing @y/y from 14.0.0-rc.26',
	);
}

if (process.argv[2] === '--measure') {
	const update = new Uint8Array(await Bun.file(process.argv[3]!).arrayBuffer());
	Bun.gc(true);
	const before = process.memoryUsage();
	const start = performance.now();
	const doc = reopen(update);
	const openMs = performance.now() - start;
	Bun.gc(true);
	const after = process.memoryUsage();
	console.log(
		JSON.stringify({
			bytes: update.length,
			structs: [...doc.store.clients.values()].reduce(
				(n, structs) => n + structs.length,
				0,
			),
			writers: doc.store.clients.size,
			openMs,
			rssDelta: after.rss - before.rss,
		}),
	);
	doc.destroy();
} else {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-root-rotation-'));
	const results = [];
	try {
		for (const writers of [1, 100, 1000, 10000]) {
			for (const wrapped of [false, true]) {
				const doc = seed(wrapped);
				const initial = encode(doc);
				const vector = Y.encodeStateVector(doc);
				// Independent sessions share one seed and write disjoint row IDs.
				for (let writer = 0; writer < writers; writer++) {
					const peer = reopen(initial);
					for (let i = writer; i < 10000; i += writers) {
						peer.transact(() =>
							put(rows(peer, wrapped), `dead-${i}`, 'Deleted'),
						);
						peer.transact(() => deleteRow(rows(peer, wrapped), `dead-${i}`));
					}
					Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(peer, vector));
					peer.destroy();
				}
				const variants = [
					{
						name: wrapped ? 'wrapped-fold' : 'current-fold',
						doc,
						operationMs: 0,
					},
				];
				if (wrapped) {
					const rotated = reopen(encode(doc));
					let start = performance.now();
					reconstruct(rotated);
					variants.push({
						name: 'replace-container',
						doc: rotated,
						operationMs: performance.now() - start,
					});
					start = performance.now();
					const fresh = reconstruct(doc, true);
					variants.push({
						name: 'fresh-document',
						doc: fresh,
						operationMs: performance.now() - start,
					});
				}
				for (const variant of variants) {
					const start = performance.now();
					const update = encode(variant.doc);
					const encodeMs = performance.now() - start;
					const path = join(directory, 'update.bin');
					await Bun.write(path, update);
					const samples = [];
					for (let sample = 0; sample < 3; sample++) {
						const child = Bun.spawn(
							[process.execPath, import.meta.path, '--measure', path],
							{ stdout: 'pipe', stderr: 'pipe' },
						);
						const [stdout, stderr, code] = await Promise.all([
							new Response(child.stdout).text(),
							new Response(child.stderr).text(),
							child.exited,
						]);
						if (code !== 0) throw new Error(stderr);
						samples.push(JSON.parse(stdout));
					}
					results.push({
						workload: {
							liveRows: 100,
							deletedRows: 10000,
							writingSessions: writers,
						},
						variant: variant.name,
						operationMs: variant.operationMs,
						encodeMs,
						samples,
					});
					variant.doc.destroy();
				}
			}
		}
		console.log(
			JSON.stringify(
				{
					date: new Date().toISOString(),
					package: packageInfo.name,
					version: packageInfo.version,
					bun: Bun.version,
					platform: platform(),
					arch: arch(),
					cpu: cpus()[0]?.model,
					results,
				},
				null,
				2,
			),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

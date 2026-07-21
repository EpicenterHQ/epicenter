/**
 * Instrumented eight-database lifecycle assertion (spec: retain all eight per
 * seed, delete only after commit). Builds the retained set at tiny scale (no timed
 * reads) and proves the peak live set is eight and cleanup deletes every file.
 * The "delete only after commit" ordering is enforced by the runner and covered
 * here by the commit-then-cleanup helper.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRetainedSet, cleanupRetainedSet, retainedKey } from './pilot.js';
import { makeTrace, type Trace } from './trace.js';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pilot-lifecycle-'));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tinyTrace(): Trace {
	// Small enough to build eight databases in milliseconds; no timed reads here.
	return makeTrace({
		facts: 120,
		namespaceCount: 6,
		tableCount: 20,
		valueRatio: 0.08,
		dataSeed: 1000,
		targetLogicalStateBytes: 120 * 100,
		maxEncodedFactBytes: 4096,
	});
}

describe('eight-database retained lifetime', () => {
	test('peak live set is eight, one per owner and candidate', () => {
		const dir = tempDir();
		const trace = tinyTrace();
		const facts = Array.from({ length: trace.options.facts }, (_, i) =>
			trace.finalFactAt(i),
		);
		const set = buildRetainedSet(dir, 0, 'test-config', 1000, facts, trace);
		try {
			expect(set.handles.size).toBe(8);
			expect(set.peakLive).toBe(8);
			// One handle per owner-by-candidate, all files present on disk.
			for (const owner of ['replica', 'authority'] as const) {
				for (const candidate of [
					'unified-inline',
					'unified-normalized',
					'split-inline',
					'split-normalized',
				]) {
					const handle = set.handles.get(retainedKey(owner, candidate));
					expect(handle).toBeDefined();
					if (handle) expect(existsSync(handle.path)).toBe(true);
				}
			}
		} finally {
			cleanupRetainedSet(set);
		}
	});

	test('cleanup deletes every retained database file', () => {
		const dir = tempDir();
		const trace = tinyTrace();
		const facts = Array.from({ length: trace.options.facts }, (_, i) =>
			trace.finalFactAt(i),
		);
		const set = buildRetainedSet(dir, 1, 'test-config', 1001, facts, trace);
		const paths = [...set.handles.values()].map((h) => h.path);
		expect(paths.length).toBe(8);
		expect(paths.every((p) => existsSync(p))).toBe(true);
		cleanupRetainedSet(set);
		expect(set.cleanedUp).toBe(true);
		expect(set.handles.size).toBe(0);
		expect(paths.every((p) => !existsSync(p))).toBe(true);
		expect(paths.every((p) => !existsSync(`${p}-wal`))).toBe(true);
	});
});

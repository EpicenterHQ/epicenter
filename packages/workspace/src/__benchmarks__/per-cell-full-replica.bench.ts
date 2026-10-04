/**
 * Per-Cell Full-Replica Benchmark
 *
 * Compares the current whole-row YKeyValueLww table with the proposed physical
 * layout: one row-presence map and one root Y.Map per cell. This is a report,
 * not a threshold test.
 *
 * The release-gate metric is FRESH-PROCESS RELOAD RSS: the final encoded
 * update is written to a temp file and applied inside a spawned `bun` child,
 * which reports its own memory delta after GC. That models "user opens the
 * app tomorrow." In-session RSS after churn is also reported, but it includes
 * transaction garbage and allocator slack the next open never pays; do not
 * gate on it. Per-process heap deltas measured mid-run proved unreliable in
 * Bun (returned 0 B) and are only reported from the fresh child process.
 *
 * Knobs (env):
 * - `WORKSPACE_BENCH_ROWS`        row count (default 10000)
 * - `WORKSPACE_BENCH_CHURN`       mixed patch/delete/reinsert ops (default 20000)
 * - `WORKSPACE_BENCH_TEXT_BYTES`  padding appended to the `preview` cell per
 *                                 row (default 0). Set ~2048 to model a
 *                                 Whispering-style transcript payload, which
 *                                 dominates encoded size independent of layout.
 * - `WORKSPACE_BENCH_LAYOUT`      'whole-row' | 'per-cell' (default: both,
 *                                 sequentially; prefer isolated runs)
 *
 * Run the release-gate shape with:
 * `bun run --filter @epicenter/workspace bench:per-cell`
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import { defineTable } from '../document/define-table.js';
import { attachTable } from '../document/table.js';
import { formatBytes, generateId, measureTime } from './helpers.js';

const CELL_KEYS = [
	'title',
	'subtitle',
	'preview',
	'status',
	'pinned',
	'archived',
	'sortOrder',
	'wordCount',
	'createdAt',
	'updatedAt',
	'folderId',
	'source',
] as const;

type CellKey = (typeof CELL_KEYS)[number];

type BenchRow = {
	id: string;
	title: string;
	subtitle: string;
	preview: string;
	status: 'draft' | 'ready';
	pinned: boolean;
	archived: boolean;
	sortOrder: number;
	wordCount: number;
	createdAt: number;
	updatedAt: number;
	folderId: string;
	source: string;
};

type Layout = {
	delete(id: string): void;
	doc: Y.Doc;
	insert(row: BenchRow): void;
	patch(id: string, version: number): void;
	/** Verify the reloaded doc sees the expected live rows. Returns the count. */
	countRows(doc: Y.Doc): number;
};

type FreshReload = {
	applyMs: number;
	rssDeltaBytes: number;
};

type Measurement = {
	churnMs: number;
	finalUpdateBytes: number;
	insertMs: number;
	insertUpdateBytes: number;
	name: string;
	reload: FreshReload;
	rowCount: number;
	sessionRssBytes: number;
};

const wholeRowDefinition = defineTable({
	id: field.string(),
	title: field.string(),
	subtitle: field.string(),
	preview: field.string(),
	status: field.select(['draft', 'ready']),
	pinned: field.boolean(),
	archived: field.boolean(),
	sortOrder: field.number(),
	wordCount: field.integer(),
	createdAt: field.number(),
	updatedAt: field.number(),
	folderId: field.string(),
	source: field.string(),
});

function envCount(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer, received '${raw}'`);
	}
	return parsed;
}

function sessionRss(): number {
	Bun.gc(true);
	return process.memoryUsage().rss;
}

const textPadding = 'x'.repeat(envCount('WORKSPACE_BENCH_TEXT_BYTES', 0));

function makeRow(index: number, version: number): BenchRow {
	const id = generateId(index);
	return {
		id,
		title: `Record ${index} revision ${version}`,
		subtitle: `Subtitle ${index % 100}`,
		preview: `Preview text for record ${index}.${textPadding}`,
		status: version % 3 === 0 ? 'ready' : 'draft',
		pinned: version % 11 === 0,
		archived: version % 17 === 0,
		sortOrder: index,
		wordCount: 100 + (version % 900),
		createdAt: 1_700_000_000_000 + index,
		updatedAt: 1_700_000_000_000 + version,
		folderId: `folder-${index % 50}`,
		source: `source-${index % 8}`,
	};
}

function createWholeRowLayout(): Layout {
	const doc = new Y.Doc({ gc: true });
	const table = attachTable(doc, 'records', wholeRowDefinition);
	return {
		doc,
		insert(row) {
			table.set(row);
		},
		patch(id, version) {
			table.update(id, {
				title: `Record ${id} revision ${version}`,
				updatedAt: 1_700_000_000_000 + version,
			});
		},
		delete(id) {
			table.delete(id);
		},
		countRows(reloaded) {
			return attachTable(reloaded, 'records', wholeRowDefinition).storedCount();
		},
	};
}

function createPerCellLayout(): Layout {
	const doc = new Y.Doc({ gc: true });
	const rows = doc.getMap<boolean>('table:records:rows');
	const cells = new Map<CellKey, Y.Map<unknown>>(
		CELL_KEYS.map((key) => [
			key,
			doc.getMap<unknown>(`table:records:cell:${key}`),
		]),
	);
	function cell(key: CellKey): Y.Map<unknown> {
		const map = cells.get(key);
		if (map === undefined)
			throw new Error(`Missing benchmark cell map '${key}'`);
		return map;
	}

	return {
		doc,
		insert(row) {
			doc.transact(() => {
				rows.set(row.id, true);
				for (const key of CELL_KEYS) cell(key).set(row.id, row[key]);
			});
		},
		patch(id, version) {
			doc.transact(() => {
				cell('title').set(id, `Record ${id} revision ${version}`);
				cell('updatedAt').set(id, 1_700_000_000_000 + version);
			});
		},
		delete(id) {
			doc.transact(() => {
				rows.delete(id);
				for (const cell of cells.values()) cell.delete(id);
			});
		},
		countRows(reloaded) {
			return reloaded.getMap<boolean>('table:records:rows').size;
		},
	};
}

function runChurn(
	layout: Layout,
	rowCount: number,
	churnCount: number,
): void {
	for (let operation = 0; operation < churnCount; operation++) {
		const mode = operation % 20;
		const index =
			mode === 1 ? (operation - 1) % rowCount : operation % rowCount;
		const id = generateId(index);

		if (mode === 0) {
			layout.delete(id);
		} else if (mode === 1) {
			layout.insert(makeRow(index, operation));
		} else {
			layout.patch(id, operation);
		}
	}
}

/**
 * Apply the final update inside a fresh `bun` child process and report its
 * own post-GC memory delta. This is the steady-state number a real app pays
 * on its next open; the parent process's RSS is polluted by churn garbage.
 */
function measureFreshReload(update: Uint8Array): FreshReload {
	const updatePath = join(
		tmpdir(),
		`workspace-bench-${process.pid}-${Math.random().toString(36).slice(2)}.bin`,
	);
	Bun.write(updatePath, update);
	const childScript = `
		const Y = await import('yjs');
		const bytes = new Uint8Array(await Bun.file(${JSON.stringify(updatePath)}).arrayBuffer());
		Bun.gc(true);
		const before = process.memoryUsage();
		const doc = new Y.Doc({ gc: true });
		const start = performance.now();
		Y.applyUpdate(doc, bytes);
		const applyMs = performance.now() - start;
		Bun.gc(true);
		const after = process.memoryUsage();
		console.log(JSON.stringify({
			applyMs,
			rssDeltaBytes: after.rss - before.rss,
		}));
	`;
	try {
		const result = Bun.spawnSync(['bun', '-e', childScript], {
			cwd: import.meta.dir,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`fresh-reload child failed: ${result.stderr.toString()}`,
			);
		}
		return JSON.parse(result.stdout.toString()) as FreshReload;
	} finally {
		Bun.spawnSync(['rm', '-f', updatePath]);
	}
}

function measureLayout(
	name: string,
	rowCount: number,
	churnCount: number,
): Measurement {
	const layout =
		name === 'per-cell' ? createPerCellLayout() : createWholeRowLayout();

	const insert = measureTime(() => {
		for (let index = 0; index < rowCount; index++) {
			layout.insert(makeRow(index, 0));
		}
	});
	const insertUpdateBytes = Y.encodeStateAsUpdate(layout.doc).byteLength;

	const churn = measureTime(() => runChurn(layout, rowCount, churnCount));
	const sessionRssBytes = sessionRss();
	const finalUpdate = Y.encodeStateAsUpdate(layout.doc);

	// Sanity: a fresh in-process doc must see the same live rows the child does.
	const verifyDoc = new Y.Doc({ gc: true });
	Y.applyUpdate(verifyDoc, finalUpdate);
	const liveRows = layout.countRows(verifyDoc);
	verifyDoc.destroy();
	if (liveRows === 0) throw new Error('reload verification saw zero rows');

	const reload = measureFreshReload(finalUpdate);

	layout.doc.destroy();

	return {
		name,
		rowCount,
		insertMs: insert.durationMs,
		churnMs: churn.durationMs,
		sessionRssBytes,
		insertUpdateBytes,
		finalUpdateBytes: finalUpdate.byteLength,
		reload,
	};
}

function formatDuration(durationMs: number): string {
	return `${durationMs.toFixed(0)} ms`;
}

function printMeasurements(
	measurements: readonly Measurement[],
	rowCount: number,
	churnCount: number,
	textBytes: number,
): void {
	console.log('\n=== PER-CELL FULL-REPLICA RELEASE-GATE PROXY ===');
	console.log(
		`${rowCount.toLocaleString()} rows x ${CELL_KEYS.length} cells, ${churnCount.toLocaleString()} churn operations, ${textBytes} text-padding bytes/row`,
	);
	console.log(
		'Gate metric: fresh-process reload RSS (steady state). Session RSS includes churn garbage; do not gate on it. Confirm the final budget on the supported device.',
	);
	console.table(
		measurements.map((measurement) => ({
			layout: measurement.name,
			insert: formatDuration(measurement.insertMs),
			churn: formatDuration(measurement.churnMs),
			'session RSS (incl. garbage)': formatBytes(measurement.sessionRssBytes),
			'update after insert': formatBytes(measurement.insertUpdateBytes),
			'update after churn': formatBytes(measurement.finalUpdateBytes),
			'fresh reload': formatDuration(measurement.reload.applyMs),
			'reload RSS Δ': formatBytes(measurement.reload.rssDeltaBytes),
			'reload RSS/row': formatBytes(
				measurement.reload.rssDeltaBytes / measurement.rowCount,
			),
		})),
	);
}

function requestedLayouts(): string[] {
	const requested = Bun.env.WORKSPACE_BENCH_LAYOUT;
	const layouts = ['whole-row', 'per-cell'];
	if (requested === undefined) return layouts;
	if (!layouts.includes(requested)) {
		throw new Error(
			`WORKSPACE_BENCH_LAYOUT must be 'whole-row' or 'per-cell', received '${requested}'`,
		);
	}
	return [requested];
}

describe('per-cell full-replica storage', () => {
	test('compares whole-row and per-cell layouts under insert and churn load', () => {
		const rowCount = envCount('WORKSPACE_BENCH_ROWS', 10_000);
		const churnCount = envCount('WORKSPACE_BENCH_CHURN', 20_000);
		const textBytes = envCount('WORKSPACE_BENCH_TEXT_BYTES', 0);
		const measurements = requestedLayouts().map((name) =>
			measureLayout(name, rowCount, churnCount),
		);

		printMeasurements(measurements, rowCount, churnCount, textBytes);
	}, 300_000);
});

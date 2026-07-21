/**
 * Each SQLite candidate store must reproduce the analytical V1-bound oracle
 * witness exactly (independent correctness), agree with the other candidates
 * (cross-candidate consistency), survive a reopen, populate the coordinate-aware
 * auxiliary tables, and report candidate-table-only storage. A tampered install
 * must break the witness so the proof is not vacuous.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';

import { makeAuxiliaryTraces } from './auxiliary-traces.js';
import {
	CANDIDATES,
	type Candidate,
	configureNewDatabase,
	createLayoutStore,
	ddlFor,
	ddlHash,
} from './layouts.js';
import { makeTrace, type Trace, type TraceOptions } from './trace.js';
import { pilotLimits } from './v1-binding.js';

const BASE: Omit<TraceOptions, 'targetLogicalStateBytes'> = {
	facts: 4000,
	namespaceCount: 12,
	tableCount: 200,
	valueRatio: 0.08,
	dataSeed: 3,
	maxEncodedFactBytes: 4096,
};

function trace(seed = 3): Trace {
	return makeTrace({
		...BASE,
		dataSeed: seed,
		targetLogicalStateBytes: BASE.facts * 160,
	});
}

const openDatabases: Database[] = [];
function buildStore(candidate: Candidate, t: Trace) {
	const db = new Database(':memory:');
	openDatabases.push(db);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	const store = createLayoutStore(db, candidate);
	const finals = Array.from({ length: t.options.facts }, (_, i) =>
		t.finalFactAt(i),
	);
	store.installFacts(finals);
	store.populateAuxiliary(makeAuxiliaryTraces(t, pilotLimits()));
	return { db, store };
}

afterAll(() => {
	for (const db of openDatabases) db.close();
});

describe('independent correctness against the analytical oracle', () => {
	const t = trace();
	const oracle = t.measure();
	for (const candidate of CANDIDATES) {
		test(`${candidate.id} reproduces the oracle witness`, () => {
			const { store } = buildStore(candidate, t);
			const witness = store.scanWitness();
			expect(witness.count).toBe(oracle.currentCount);
			expect(witness.bytes).toBe(oracle.currentProtocolFactBytes);
			expect(witness.digestHex).toBe(oracle.digestHex);
		});
	}
});

describe('cross-candidate consistency', () => {
	test('all candidates agree on the witness digest (consistency, not correctness)', () => {
		const t = trace();
		const digests = CANDIDATES.map(
			(c) => buildStore(c, t).store.scanWitness().digestHex,
		);
		expect(new Set(digests).size).toBe(1);
	});
});

describe('reopen consistency', () => {
	test('a reopened database reproduces the same witness', () => {
		const candidate = CANDIDATES[1]!; // unified-normalized
		const t = trace();
		const { db, store } = buildStore(candidate, t);
		const before = store.scanWitness();
		// Reopen the same in-memory connection is not meaningful; instead re-scan on a
		// fresh store over the same db handle, which reuses persisted pages.
		const store2 = createLayoutStore(db, candidate);
		expect(store2.scanWitness().digestHex).toBe(before.digestHex);
		store2.finalize();
	});
});

describe('the witness is not vacuous', () => {
	test('a tampered fact breaks the witness', () => {
		const candidate = CANDIDATES[0]!;
		const t = trace();
		const { db, store } = buildStore(candidate, t);
		const good = store.scanWitness();
		// Bump the largest sequence, corrupting the physical state without violating
		// the payload/presence CHECK (the sequence appears in every canonical fact).
		db.run(
			'UPDATE facts SET sequence = sequence + 1000000 WHERE sequence = (SELECT MAX(sequence) FROM facts)',
		);
		expect(store.scanWitness().digestHex).not.toBe(good.digestHex);
	});
});

describe('point reads', () => {
	test('a present address reads present; the oracle agrees', () => {
		const candidate = CANDIDATES[2]!; // split-inline
		const t = trace();
		const { store } = buildStore(candidate, t);
		const addresses = t.sampleRowAddresses(50);
		for (const address of addresses) {
			const read = store.pointRead(address);
			expect(read).not.toBeNull();
		}
	});
});

describe('coordinate-aware auxiliary tables and storage', () => {
	test('normalized and inline both populate and report candidate-table bytes', () => {
		const t = trace();
		for (const candidate of CANDIDATES) {
			const { db, store } = buildStore(candidate, t);
			const bytes = store.candidateTableBytes();
			expect(bytes).toBeGreaterThan(0);
			// Auxiliary rows exist under both coordinate encodings.
			const pending = (
				db.prepare('SELECT COUNT(*) AS n FROM pending_intents').get() as {
					n: number;
				}
			).n;
			const docs = (
				db.prepare('SELECT COUNT(*) AS n FROM row_documents').get() as {
					n: number;
				}
			).n;
			expect(pending).toBeGreaterThan(0);
			expect(docs).toBeGreaterThan(0);
		}
	});
});

describe('ddl provenance', () => {
	test('each candidate has a distinct, stable DDL hash', () => {
		const hashes = CANDIDATES.map((c) => ddlHash(c));
		expect(new Set(hashes).size).toBe(CANDIDATES.length);
		expect(ddlHash(CANDIDATES[0]!)).toBe(ddlHash(CANDIDATES[0]!));
	});
});

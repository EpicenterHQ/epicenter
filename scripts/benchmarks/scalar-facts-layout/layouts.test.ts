/**
 * Each SQLite candidate store must reproduce the analytical V1-bound oracle
 * witness exactly (independent correctness), agree with the other candidates
 * (cross-candidate consistency), reproduce a scan through a fresh store wrapper,
 * populate coordinate-aware auxiliary tables, and report candidate-table-only
 * storage. A tampered install must break the witness so the proof is not vacuous.
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
import {
	addressKey,
	makeTrace,
	type Trace,
	type TraceOptions,
} from './trace.js';
import { pilotLimits } from './v1-binding.js';

const BASE: Omit<TraceOptions, 'targetLogicalStateBytes'> = {
	facts: 4000,
	namespaceCount: 12,
	tableCount: 200,
	valueRatio: 0.08,
	dataSeed: 3,
	maxEncodedFactBytes: 4096,
};

const EXPECTED_DDL_HASHES: Readonly<Record<string, string>> = {
	'unified-inline':
		'4ee46a69403c6ed7cf0cfd767370708ccf3a05753db3255e89a88b2de8f3dd8c',
	'unified-normalized':
		'92fb00af3b6deae10fca1df676b4f96037b4165c7b09c0385e8a61fcfbd3dfbc',
	'split-inline':
		'5ebceb75a3edf16043f3890cd42e6318e8aeeece6dc4d86f8b84deecb8e61859',
	'split-normalized':
		'701a374bd3c07f2cb1b494e0049a94c5606e24dc0e34fda2c0cc136b0c267722',
};

function trace(seed = 3): Trace {
	return makeTrace({
		...BASE,
		dataSeed: seed,
		targetLogicalStateBytes: BASE.facts * 160,
	});
}

function requiredCandidate(id: string): Candidate {
	const candidate = CANDIDATES.find((value) => value.id === id);
	if (candidate === undefined)
		throw new Error(`missing candidate fixture '${id}'`);
	return candidate;
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
	const aux = makeAuxiliaryTraces(t, pilotLimits());
	store.populateReplicaAuxiliary(aux);
	store.populateAuthorityAuxiliary(aux);
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

describe('same-handle rescan consistency', () => {
	test('a fresh store wrapper over the same open database reproduces the witness', () => {
		const candidate = requiredCandidate('unified-normalized');
		const t = trace();
		const { db, store } = buildStore(candidate, t);
		const before = store.scanWitness();
		const store2 = createLayoutStore(db, candidate);
		expect(store2.scanWitness().digestHex).toBe(before.digestHex);
		store2.finalize();
	});
});

describe('the witness is not vacuous', () => {
	test('a tampered fact breaks the witness', () => {
		const candidate = requiredCandidate('unified-inline');
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
	test('sampled row reads reproduce the analytical presence and sequence', () => {
		const candidate = requiredCandidate('split-inline');
		const t = trace();
		const { store } = buildStore(candidate, t);
		const analytical = new Map(
			Array.from({ length: t.options.facts }, (_, index) => {
				const fact = t.finalFactAt(index);
				return [
					addressKey(fact.address),
					{
						present: fact.presence === 'present' ? 1 : 0,
						sequence: fact.sequence,
					},
				] as const;
			}),
		);
		const addresses = t.sampleRowAddresses(50);
		for (const address of addresses) {
			const expected = analytical.get(addressKey(address));
			if (expected === undefined)
				throw new Error('sampled address missing from analytical trace');
			expect(store.pointRead(address)).toEqual(expected);
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
	test('each candidate matches its frozen DDL compatibility digest', () => {
		for (const candidate of CANDIDATES) {
			const expected = EXPECTED_DDL_HASHES[candidate.id];
			if (expected === undefined)
				throw new Error(`missing frozen DDL digest for '${candidate.id}'`);
			expect(ddlHash(candidate)).toBe(expected);
		}
		expect(new Set(Object.values(EXPECTED_DDL_HASHES)).size).toBe(
			CANDIDATES.length,
		);
	});
});

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { canonicalize } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import {
	openSplitReplicaStore,
	type SplitReplicaStore,
} from '../replica-split/index.js';
import type {
	DocumentAction,
	DocumentActionResult,
	DocumentConformanceBinding,
	DocumentConformanceReplica,
} from './document-cases.test-support.js';
import type {
	ConformanceReplica,
	CrashedReplica,
	ReplicaConformanceBinding,
	ReplicaObservations,
	ReplicaTransition,
} from './replica-cases.test-support.js';

const LIMITS = makeLimits();

let copyCounter = 0;

class CapturedCrash extends Error {}

function run(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[] = [],
): void {
	database.run(sql, parameters as SQLQueryBindings[]);
}

function all<TRow extends SqliteRow>(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[] = [],
): TRow[] {
	return database
		.query<TRow, SQLQueryBindings[]>(sql)
		.all(...(parameters as SQLQueryBindings[]));
}

function countingAdapter(database: Database) {
	let writes = 0;
	const adapter: SqliteDatabase = {
		run(sql, parameters): void {
			writes += 1;
			run(database, sql, parameters);
		},
		all<TRow extends SqliteRow>(
			sql: string,
			parameters?: readonly SqliteValue[],
		) {
			return all<TRow>(database, sql, parameters);
		},
		transaction<TResult>(work: () => TResult): TResult {
			return database.transaction(work).immediate();
		},
	};
	return { adapter, writes: () => writes };
}

function crashAdapter(
	database: Database,
	path: string,
	recoveredPath: string,
	boundary: number,
): SqliteDatabase {
	let isInsideTransaction = false;
	let writes = 0;
	return {
		run(sql, parameters): void {
			run(database, sql, parameters);
			if (!isInsideTransaction) return;
			writes += 1;
			if (writes !== boundary) return;
			copyFileSync(path, recoveredPath);
			const journal = `${path}-journal`;
			if (existsSync(journal)) {
				copyFileSync(journal, `${recoveredPath}-journal`);
			}
			throw new CapturedCrash();
		},
		all<TRow extends SqliteRow>(
			sql: string,
			parameters?: readonly SqliteValue[],
		) {
			return all<TRow>(database, sql, parameters);
		},
		transaction<TResult>(work: () => TResult): TResult {
			run(database, 'BEGIN IMMEDIATE');
			isInsideTransaction = true;
			try {
				const result = work();
				isInsideTransaction = false;
				run(database, 'COMMIT');
				return result;
			} catch (cause) {
				isInsideTransaction = false;
				run(database, 'ROLLBACK');
				throw cause;
			}
		},
	};
}

function logicalState(database: Database): string {
	const meta = all<Record<string, string | number | null>>(
		database,
		'SELECT * FROM meta WHERE singleton = 1',
	)[0];
	const confirmedRecords = all<Record<string, string | number | null>>(
		database,
		`SELECT * FROM confirmed_records
		ORDER BY namespace, collection, record_key`,
	);
	const localIntents = all<Record<string, string | number | null>>(
		database,
		`SELECT * FROM local_intents
		ORDER BY namespace, collection, record_key`,
	);
	const recordDocuments = all<Record<string, string | number | null>>(
		database,
		`SELECT namespace, collection, record_key, revision, dirty
		FROM record_documents
		ORDER BY namespace, collection, record_key`,
	);
	const documentChains = all<Record<string, string | number | null>>(
		database,
		`SELECT r.namespace, r.collection, r.record_key, c.seq, c.kind,
			hex(c.bytes) AS bytes
		FROM document_chains c
		LEFT JOIN record_documents r ON r.doc_id = c.doc_id
		ORDER BY r.namespace, r.collection, r.record_key, c.doc_id, c.seq`,
	);
	const documentInflight = all<Record<string, string | number | null>>(
		database,
		`SELECT r.namespace, r.collection, r.record_key,
			hex(i.payload) AS payload, i.digest, i.captured_revision,
			i.parked_code, i.measured_bytes, i.measured_structs,
			i.limit_bytes, i.limit_structs
		FROM document_inflight i
		LEFT JOIN record_documents r ON r.doc_id = i.doc_id
		ORDER BY r.namespace, r.collection, r.record_key, i.doc_id`,
	);
	const blobState = all<Record<string, string | number | null>>(
		database,
		`SELECT * FROM blob_state
		ORDER BY namespace, collection, record_key`,
	);
	return canonicalize(
		JSON.parse(
			JSON.stringify({
				meta,
				confirmedRecords,
				localIntents,
				recordDocuments,
				documentChains,
				documentInflight,
				blobState,
			}),
		),
	);
}

type StoreAction<TResult = void> = (store: SplitReplicaStore) => TResult;

class BunSplitReplicaFixture {
	private constructor(
		readonly path: string,
		readonly database: Database,
		readonly store: SplitReplicaStore,
		private ownedDirectory: string | null,
	) {}

	static create(fixture: {
		replicaId: string;
		authorityLifetime?: string;
	}): BunSplitReplicaFixture {
		const directory = mkdtempSync(join(tmpdir(), 'epicenter-bun-split-replica-'));
		const path = join(directory, 'replica.sqlite');
		const database = new Database(path, { create: true, strict: true });
		database.run('PRAGMA journal_mode = DELETE');
		const store = openSplitReplicaStore({
			database: createBunSqliteAdapter(database),
			limits: LIMITS,
			initialize: fixture,
		});
		return new BunSplitReplicaFixture(path, database, store, directory);
	}

	static open(path: string): BunSplitReplicaFixture {
		const database = new Database(path, { strict: true });
		return new BunSplitReplicaFixture(
			path,
			database,
			openSplitReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
			}),
			null,
		);
	}

	analyze<TResult>(action: StoreAction<TResult>): {
		boundaries: number;
		result: TResult;
	} {
		copyCounter += 1;
		const path = `${this.path}.analysis-${copyCounter}`;
		copyFileSync(this.path, path);
		const database = new Database(path, { strict: true });
		try {
			const counted = countingAdapter(database);
			const store = openSplitReplicaStore({
				database: counted.adapter,
				limits: LIMITS,
			});
			const result = action(store);
			return { boundaries: counted.writes(), result };
		} finally {
			database.close();
			rmSync(path, { force: true });
		}
	}

	crash(action: StoreAction, boundary: number): BunSplitReplicaFixture {
		copyCounter += 1;
		const workingPath = `${this.path}.working-${copyCounter}`;
		const recoveredPath = `${this.path}.crash-${copyCounter}`;
		copyFileSync(this.path, workingPath);
		const database = new Database(workingPath, { strict: true });
		try {
			const store = openSplitReplicaStore({
				database: crashAdapter(database, workingPath, recoveredPath, boundary),
				limits: LIMITS,
			});
			action(store);
			throw new Error(`fault boundary ${boundary} was not reached`);
		} catch (cause) {
			if (!(cause instanceof CapturedCrash)) throw cause;
		} finally {
			database.close();
			rmSync(workingPath, { force: true });
			rmSync(`${workingPath}-journal`, { force: true });
		}
		return BunSplitReplicaFixture.open(recoveredPath);
	}

	reopen(): BunSplitReplicaFixture {
		this.database.close();
		const reopened = BunSplitReplicaFixture.open(this.path);
		reopened.ownedDirectory = this.ownedDirectory;
		this.ownedDirectory = null;
		return reopened;
	}

	snapshot(): string {
		return logicalState(this.database);
	}

	close(): void {
		this.database.close();
	}

	dispose(): void {
		this.database.close();
		if (this.ownedDirectory !== null) {
			rmSync(this.ownedDirectory, { recursive: true, force: true });
			this.ownedDirectory = null;
		}
	}
}

function observations(fixture: BunSplitReplicaFixture): ReplicaObservations {
	return {
		record: (address) => fixture.store.record(address),
		sync: () => fixture.store.sync(),
		sealedRequest: () => fixture.store.sealedRequest(),
		snapshot: () => fixture.snapshot(),
	};
}

function transition(
	fixture: BunSplitReplicaFixture,
	action: StoreAction,
	boundaries = fixture.analyze(action).boundaries,
): ReplicaTransition {
	return {
		boundaries,
		crash(boundary): CrashedReplica {
			const crashed = fixture.crash(action, boundary);
			return { ...observations(crashed), close: () => crashed.close() };
		},
		commit: () => action(fixture.store),
	};
}

function conformanceReplica(fixture: BunSplitReplicaFixture): ConformanceReplica {
	return {
		...observations(fixture),
		localWrite: (intent) =>
			transition(fixture, (store) => store.localWrite(intent)),
		seal: () => {
			const action = (store: SplitReplicaStore) => store.seal();
			const analyzed = fixture.analyze(action);
			return {
				transition: transition(fixture, action, analyzed.boundaries),
				requestBytes: analyzed.result.bytes,
				requestHash: analyzed.result.hash,
			};
		},
		settle: (response) =>
			transition(fixture, (store) => store.settle(response)),
		installFacts: (page) =>
			transition(fixture, (store) => store.installFacts(page)),
		erase: () => transition(fixture, (store) => store.erase()),
		reconstructSealedRequest: () => fixture.store.reconstructSealedRequest(),
		reopen: () => conformanceReplica(fixture.reopen()),
		dispose: () => fixture.dispose(),
	};
}

export const bunSplitReplicaBinding: ReplicaConformanceBinding = {
	name: 'complete split Bun replica store',
	create: (fixture) => conformanceReplica(BunSplitReplicaFixture.create(fixture)),
};

const DOCUMENT_ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function documentAction(
	store: SplitReplicaStore,
	action: DocumentAction,
): DocumentActionResult {
	switch (action.kind) {
		case 'append-local':
			store.appendLocalDocumentUpdate(action.address, action.update);
			return undefined;
		case 'install-accepted':
			store.installAcceptedDocumentUpdate(action.address, action.update);
			return undefined;
		case 'publication':
			return store.documentPublication(action.address);
		case 'settle-publication':
			store.settleDocumentPublication(action.address, action.proof);
			return undefined;
		case 'local-write':
			store.localWrite(action.intent);
			return undefined;
	}
}

function documentConformanceReplica(
	fixture: BunSplitReplicaFixture,
): DocumentConformanceReplica {
	return {
		inspectDocument: (address) => fixture.store.inspectDocument(address),
		exportDocument: (address) => fixture.store.exportDocument(address),
		snapshot: () => fixture.snapshot(),
		prepare(action) {
			const execute = (store: SplitReplicaStore) => documentAction(store, action);
			const analyzed = fixture.analyze(execute);
			return {
				boundaries: analyzed.boundaries,
				crash(boundary) {
					const crashed = fixture.crash(execute, boundary);
					return {
						inspectDocument: (address) =>
							crashed.store.inspectDocument(address),
						exportDocument: (address) => crashed.store.exportDocument(address),
						snapshot: () => crashed.snapshot(),
						close: () => crashed.close(),
					};
				},
				commit: () => execute(fixture.store),
			};
		},
		reopen: () => documentConformanceReplica(fixture.reopen()),
		dispose: () => fixture.dispose(),
	};
}

export const bunSplitDocumentBinding: DocumentConformanceBinding = {
	name: 'complete split Bun replica store',
	create() {
		const fixture = BunSplitReplicaFixture.create({
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		});
		fixture.store.localWrite({
			address: DOCUMENT_ADDRESS,
			op: 'replace',
			value: {},
		});
		return documentConformanceReplica(fixture);
	},
};

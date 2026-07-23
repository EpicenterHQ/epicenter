import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { canonicalize } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { openReplicaStore, type ReplicaStore } from '../replica/index.js';
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
	const records = all<Record<string, string | number | null>>(
		database,
		'SELECT * FROM records ORDER BY namespace, collection, record_key',
	).map(({ record_id: _recordId, ...logical }) => logical);
	const documents = all<Record<string, string | number | null>>(
		database,
		`SELECT r.namespace, r.collection, r.record_key, d.seq, d.kind,
			hex(d.bytes) AS bytes
		FROM record_documents d
		JOIN records r ON r.record_id = d.record_id
		ORDER BY r.namespace, r.collection, r.record_key, d.seq`,
	);
	return canonicalize(JSON.parse(JSON.stringify({ meta, records, documents })));
}

type StoreAction<TResult = void> = (store: ReplicaStore) => TResult;

class BunReplicaFixture {
	private constructor(
		readonly path: string,
		readonly database: Database,
		readonly store: ReplicaStore,
		private ownedDirectory: string | null,
	) {}

	static create(fixture: {
		replicaId: string;
		authorityLifetime?: string;
	}): BunReplicaFixture {
		const directory = mkdtempSync(join(tmpdir(), 'epicenter-bun-replica-'));
		const path = join(directory, 'replica.sqlite');
		const database = new Database(path, { create: true, strict: true });
		database.run('PRAGMA journal_mode = DELETE');
		const store = openReplicaStore({
			database: createBunSqliteAdapter(database),
			limits: LIMITS,
			initialize: fixture,
		});
		return new BunReplicaFixture(path, database, store, directory);
	}

	static open(path: string): BunReplicaFixture {
		const database = new Database(path, { strict: true });
		return new BunReplicaFixture(
			path,
			database,
			openReplicaStore({
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
			const store = openReplicaStore({
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

	crash(action: StoreAction, boundary: number): BunReplicaFixture {
		copyCounter += 1;
		const workingPath = `${this.path}.working-${copyCounter}`;
		const recoveredPath = `${this.path}.crash-${copyCounter}`;
		copyFileSync(this.path, workingPath);
		const database = new Database(workingPath, { strict: true });
		try {
			const store = openReplicaStore({
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
		return BunReplicaFixture.open(recoveredPath);
	}

	reopen(): BunReplicaFixture {
		this.database.close();
		const reopened = BunReplicaFixture.open(this.path);
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

function observations(fixture: BunReplicaFixture): ReplicaObservations {
	return {
		record: (address) => fixture.store.record(address),
		sync: () => fixture.store.sync(),
		sealedRequest: () => fixture.store.sealedRequest(),
		snapshot: () => fixture.snapshot(),
	};
}

function transition(
	fixture: BunReplicaFixture,
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

function conformanceReplica(fixture: BunReplicaFixture): ConformanceReplica {
	return {
		...observations(fixture),
		localWrite: (intent) =>
			transition(fixture, (store) => store.localWrite(intent)),
		seal: () => {
			const action = (store: ReplicaStore) => store.seal();
			const analyzed = fixture.analyze(action);
			if (analyzed.result.kind !== 'sealed') {
				throw new Error('conformance seal action had no pending work');
			}
			return {
				transition: transition(fixture, action, analyzed.boundaries),
				requestBytes: analyzed.result.request.bytes,
				requestHash: analyzed.result.request.hash,
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

export const bunReplicaBinding: ReplicaConformanceBinding = {
	name: 'production Bun replica store',
	create: (fixture) => conformanceReplica(BunReplicaFixture.create(fixture)),
};

const DOCUMENT_ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function documentAction(
	store: ReplicaStore,
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
			store.settleDocumentPublication(
				action.address,
				action.proof,
				action.captured,
			);
			return undefined;
		case 'local-write':
			store.localWrite(action.intent);
			return undefined;
	}
}

function documentConformanceReplica(
	fixture: BunReplicaFixture,
): DocumentConformanceReplica {
	return {
		inspectDocument: (address) => fixture.store.inspectDocument(address),
		exportDocument: (address) => fixture.store.exportDocument(address),
		owedDocuments: (limit) => fixture.store.owedDocuments(limit),
		snapshot: () => fixture.snapshot(),
		prepare(action) {
			const execute = (store: ReplicaStore) => documentAction(store, action);
			const analyzed = fixture.analyze(execute);
			return {
				boundaries: analyzed.boundaries,
				crash(boundary) {
					const crashed = fixture.crash(execute, boundary);
					return {
						inspectDocument: (address) =>
							crashed.store.inspectDocument(address),
						exportDocument: (address) => crashed.store.exportDocument(address),
						owedDocuments: (limit) => crashed.store.owedDocuments(limit),
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

export const bunDocumentBinding: DocumentConformanceBinding = {
	name: 'production Bun replica store',
	create() {
		const fixture = BunReplicaFixture.create({
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

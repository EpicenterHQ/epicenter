import type { BrowserSqliteDatabase } from '@epicenter/sqlite/browser';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';

import { canonicalize } from '../src/protocol/v1/index.js';
import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import {
	openReplicaStore,
	type ReplicaStore,
} from '../src/store/replica/index.js';
import {
	OWED_BLOBS_SQL,
	OWED_DOCUMENTS_SQL,
} from '../src/store/replica/replica-store.js';
import type {
	BrowserReplicaAction,
	BrowserReplicaObservation,
	BrowserReplicaTestInbound,
	BrowserReplicaTestOutbound,
	BrowserReplicaTestRequest,
	BrowserReplicaTestResult,
} from './replica-conformance-contract.js';

type WorkerScope = {
	postMessage(message: BrowserReplicaTestOutbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaTestInbound }) => void,
	): void;
	close(): void;
};

const scope = globalThis as unknown as WorkerScope;
const limits = makeLimits();

let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let pool: SAHPoolUtil | undefined;
let database: Database | undefined;
let store: ReplicaStore | undefined;
let databaseFilename: string | undefined;

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error)
		return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

function requireDatabase(): Database {
	if (database === undefined)
		throw new Error('browser replica test database is not open');
	return database;
}

function requireStore(): ReplicaStore {
	if (store === undefined)
		throw new Error('browser replica test store is not open');
	return store;
}

function adapterFor(target: Database) {
	return createBrowserSqliteAdapter(target as unknown as BrowserSqliteDatabase);
}

function configure(target: Database): void {
	target.exec(`
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = EXTRA;
		PRAGMA temp_store = MEMORY;
	`);
}

function logicalState(target: Database): string {
	const adapter = adapterFor(target);
	const meta = adapter.all<Record<string, string | number | null>>(
		'SELECT * FROM meta WHERE singleton = 1',
	)[0];
	const records = adapter
		.all<Record<string, string | number | null>>(
			'SELECT * FROM records ORDER BY namespace, collection, record_key',
		)
		.map(({ record_id: _recordId, ...logical }) => logical);
	const documents = adapter.all<Record<string, string | number | null>>(
		`SELECT r.namespace, r.collection, r.record_key, d.seq, d.kind,
			hex(d.bytes) AS bytes
		FROM record_documents d
		JOIN records r ON r.record_id = d.record_id
		ORDER BY r.namespace, r.collection, r.record_key, d.seq`,
	);
	return canonicalize(JSON.parse(JSON.stringify({ meta, records, documents })));
}

function executeAction(target: ReplicaStore, action: BrowserReplicaAction) {
	switch (action.kind) {
		case 'append-local':
			target.appendLocalDocumentUpdate(action.address, action.update);
			return undefined;
		case 'install-accepted':
			target.installAcceptedDocumentUpdate(action.address, action.update);
			return undefined;
		case 'publication':
			return target.documentPublication(action.address);
		case 'settle-publication':
			target.settleDocumentPublication(
				action.address,
				action.proof,
				action.captured,
			);
			return undefined;
		case 'local-write':
			target.localWrite(action.intent);
			return undefined;
		case 'seal':
			{
				const outcome = target.seal();
				if (outcome.kind !== 'sealed') {
					throw new Error('browser conformance seal had no pending work');
				}
				return outcome.request;
			}
		case 'settle':
			target.settle(action.response);
			return undefined;
		case 'install-facts':
			target.installFacts(action.page);
			return undefined;
		case 'erase':
			target.erase();
			return undefined;
	}
}

function observe(
	observation: BrowserReplicaObservation,
): BrowserReplicaTestResult {
	const target = requireStore();
	switch (observation.kind) {
		case 'record':
			return target.record(observation.address);
		case 'sync':
			return target.sync();
		case 'sealed-request':
			return target.sealedRequest();
		case 'snapshot':
			return logicalState(requireDatabase());
		case 'reconstruct-sealed-request':
			return target.reconstructSealedRequest();
		case 'inspect-document':
			return target.inspectDocument(observation.address);
		case 'export-document':
			return target.exportDocument(observation.address);
		case 'owed-documents':
			return target.owedDocuments(observation.limit);
		case 'owed-query-plans': {
			const database = adapterFor(requireDatabase());
			const explain = (sql: string) =>
				database
					.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [16])
					.map(({ detail }) => detail);
			return {
				document: explain(OWED_DOCUMENTS_SQL),
				blob: explain(OWED_BLOBS_SQL),
			};
		}
	}
}

function analyze(action: BrowserReplicaAction) {
	const target = requireDatabase();
	const base = adapterFor(target);
	let writes = 0;
	const analysisAdapter = {
		run(
			sql: string,
			parameters?: readonly (string | number | Uint8Array | null)[],
		) {
			writes += 1;
			base.run(sql, parameters);
		},
		all: base.all,
		transaction<TResult>(work: () => TResult): TResult {
			base.run('BEGIN IMMEDIATE');
			try {
				const result = work();
				base.run('ROLLBACK');
				return result;
			} catch (cause) {
				base.run('ROLLBACK');
				throw cause;
			}
		},
	};
	const analysisStore = openReplicaStore({ database: analysisAdapter, limits });
	try {
		const result = executeAction(analysisStore, action);
		return { boundaries: writes, ...(result === undefined ? {} : { result }) };
	} catch (cause) {
		return { boundaries: writes, error: serializeError(cause) };
	}
}

function crash(
	action: BrowserReplicaAction,
	boundary: number,
	requestId: number,
): never {
	const target = requireDatabase();
	const base = adapterFor(target);
	let insideTransaction = false;
	let writes = 0;
	const crashAdapter = {
		run(
			sql: string,
			parameters?: readonly (string | number | Uint8Array | null)[],
		) {
			base.run(sql, parameters);
			if (!insideTransaction) return;
			writes += 1;
			if (writes !== boundary) return;
			scope.postMessage({ type: 'crash-boundary', id: requestId });
			const fence = new Int32Array(new SharedArrayBuffer(4));
			Atomics.wait(fence, 0, 0);
			throw new Error('unreachable crash fence resumed');
		},
		all: base.all,
		transaction<TResult>(work: () => TResult): TResult {
			base.run('BEGIN IMMEDIATE');
			insideTransaction = true;
			try {
				const result = work();
				insideTransaction = false;
				base.run('COMMIT');
				return result;
			} catch (cause) {
				insideTransaction = false;
				base.run('ROLLBACK');
				throw cause;
			}
		},
	};
	const crashStore = openReplicaStore({ database: crashAdapter, limits });
	executeAction(crashStore, action);
	throw new Error(`fault boundary ${boundary} was not reached`);
}

async function installPool(
	storage: Extract<BrowserReplicaTestRequest, { kind: 'open' }>['storage'],
): Promise<SAHPoolUtil> {
	sqlite ??= await sqlite3InitModule();
	let lastFailure: unknown;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			return await sqlite.installOpfsSAHPoolVfs({
				name: storage.poolName,
				directory: storage.poolDirectory,
			});
		} catch (cause) {
			lastFailure = cause;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error(
		`browser crash-recovery pool remained locked: ${
			lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
		}`,
		{
			cause: lastFailure,
		},
	);
}

async function execute(
	request: BrowserReplicaTestRequest,
	requestId: number,
): Promise<BrowserReplicaTestResult> {
	switch (request.kind) {
		case 'open': {
			if (database !== undefined)
				throw new Error('browser replica test store is already open');
			pool = await installPool(request.storage);
			databaseFilename = request.storage.databaseFilename;
			if (request.databaseBytes !== undefined) {
				await pool.importDb(databaseFilename, request.databaseBytes);
			}
			database = new pool.OpfsSAHPoolDb(databaseFilename);
			configure(database);
			store = openReplicaStore({
				database: adapterFor(database),
				limits,
				...(request.initialize === undefined
					? {}
					: { initialize: request.initialize }),
			});
			return undefined;
		}
		case 'observe':
			return observe(request.observation);
		case 'analyze':
			return analyze(request.action);
		case 'commit':
			return executeAction(requireStore(), request.action);
		case 'crash':
			return crash(request.action, request.boundary, requestId);
		case 'export': {
			const target = requireDatabase();
			if (target.pointer === undefined)
				throw new Error('browser replica database is closed');
			sqlite ??= await sqlite3InitModule();
			return sqlite.capi.sqlite3_js_db_export(target.pointer);
		}
		case 'reopen': {
			if (pool === undefined || databaseFilename === undefined)
				throw new Error('browser replica test store is not open');
			database?.close();
			database = new pool.OpfsSAHPoolDb(databaseFilename);
			configure(database);
			store = openReplicaStore({ database: adapterFor(database), limits });
			return undefined;
		}
		case 'close': {
			database?.close();
			database = undefined;
			store = undefined;
			const openedPool = pool;
			pool = undefined;
			if (request.remove) await openedPool?.removeVfs();
			else openedPool?.pauseVfs();
			scope.close();
			return undefined;
		}
	}
}

scope.addEventListener('message', ({ data: inbound }) => {
	void execute(inbound.request, inbound.id)
		.then((value) => {
			scope.postMessage({ type: 'result', id: inbound.id, value });
		})
		.catch((cause: unknown) => {
			const error = serializeError(cause);
			scope.postMessage({ type: 'error', id: inbound.id, ...error });
		});
});

import type { BrowserSqliteDatabase } from '@epicenter/sqlite/browser';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';

import { canonicalize } from '../src/protocol/v1/index.js';
import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import {
	openSplitReplicaStore,
	type SplitReplicaStore,
} from '../src/store/replica-split/index.js';
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
let store: SplitReplicaStore | undefined;
let databaseFilename: string | undefined;

function serializeError(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error)
		return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

function requireDatabase(): Database {
	if (database === undefined)
		throw new Error('browser split replica test database is not open');
	return database;
}

function requireStore(): SplitReplicaStore {
	if (store === undefined)
		throw new Error('browser split replica test store is not open');
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
	const confirmedRecords = adapter.all<Record<string, string | number | null>>(
		`SELECT * FROM confirmed_records
		ORDER BY namespace, collection, record_key`,
	);
	const localIntents = adapter.all<Record<string, string | number | null>>(
		`SELECT * FROM local_intents
		ORDER BY namespace, collection, record_key`,
	);
	const recordDocuments = adapter.all<Record<string, string | number | null>>(
		`SELECT namespace, collection, record_key, revision, dirty
		FROM record_documents
		ORDER BY namespace, collection, record_key`,
	);
	const documentChains = adapter.all<Record<string, string | number | null>>(
		`SELECT r.namespace, r.collection, r.record_key, c.seq, c.kind,
			hex(c.bytes) AS bytes
		FROM document_chains c
		LEFT JOIN record_documents r ON r.doc_id = c.doc_id
		ORDER BY r.namespace, r.collection, r.record_key, c.doc_id, c.seq`,
	);
	const documentInflight = adapter.all<Record<string, string | number | null>>(
		`SELECT r.namespace, r.collection, r.record_key,
			hex(i.payload) AS payload, i.digest, i.captured_revision,
			i.parked_code, i.measured_bytes, i.measured_structs,
			i.limit_bytes, i.limit_structs
		FROM document_inflight i
		LEFT JOIN record_documents r ON r.doc_id = i.doc_id
		ORDER BY r.namespace, r.collection, r.record_key, i.doc_id`,
	);
	const blobState = adapter.all<Record<string, string | number | null>>(
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

function executeAction(
	target: SplitReplicaStore,
	action: BrowserReplicaAction,
) {
	switch (action.kind) {
		case 'local-write':
			target.localWrite(action.intent);
			return undefined;
		case 'seal':
			return target.seal();
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
	const analysisStore = openSplitReplicaStore({
		database: analysisAdapter,
		limits,
	});
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
	const crashStore = openSplitReplicaStore({ database: crashAdapter, limits });
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
		{ cause: lastFailure },
	);
}

async function execute(
	request: BrowserReplicaTestRequest,
	requestId: number,
): Promise<BrowserReplicaTestResult> {
	switch (request.kind) {
		case 'open': {
			if (database !== undefined)
				throw new Error('browser split replica test store is already open');
			pool = await installPool(request.storage);
			databaseFilename = request.storage.databaseFilename;
			if (request.databaseBytes !== undefined) {
				await pool.importDb(databaseFilename, request.databaseBytes);
			}
			database = new pool.OpfsSAHPoolDb(databaseFilename);
			configure(database);
			store = openSplitReplicaStore({
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
				throw new Error('browser split replica database is closed');
			sqlite ??= await sqlite3InitModule();
			return sqlite.capi.sqlite3_js_db_export(target.pointer);
		}
		case 'reopen': {
			if (pool === undefined || databaseFilename === undefined)
				throw new Error('browser split replica test store is not open');
			database?.close();
			database = new pool.OpfsSAHPoolDb(databaseFilename);
			configure(database);
			store = openSplitReplicaStore({ database: adapterFor(database), limits });
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

#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
	type DocumentAcceptance,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import {
	DOCUMENT_BOUND,
	measureDocumentState,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { Miniflare } from 'miniflare';

type DocumentMeasure = ReturnType<typeof measureDocumentState>;

type DocumentState = {
	authorityLifetime: string;
	captureRevision: number;
	nextCaptureRevision: number;
	chainEntries: number;
	chainBytes: number;
	digest: string | null;
	measure: DocumentMeasure | null;
};

type PublicationResult = {
	acceptance: DocumentAcceptance;
	authorityMilliseconds: number;
	roundTripMilliseconds: number;
};

type WorkerdResponse = {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
};

type WorkerdHarness = {
	fetch(path: string, init?: RequestInit): Promise<WorkerdResponse>;
	stop(): Promise<void>;
};

const ROOT = resolve(import.meta.dir, '../../../../..');
const OBJECT = 'principal-document-struct-bound';
const ADDRESS = {
	realistic: {
		namespace: 'so.epicenter.honeycrisp',
		collection: 'notes',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	below: {
		namespace: 'so.epicenter.honeycrisp',
		collection: 'notes',
		recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	},
	exact: {
		namespace: 'so.epicenter.honeycrisp',
		collection: 'notes',
		recordKey: 'cccccccccccccccccccccccc',
	},
	above: {
		namespace: 'so.epicenter.honeycrisp',
		collection: 'notes',
		recordKey: 'dddddddddddddddddddddddd',
	},
} as const satisfies Record<string, RecordAddress>;

function assertEvidence(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) throw new Error(`document-bound evidence failed: ${message}`);
}

function encode(document: Y.Doc): Uint8Array {
	return new Uint8Array(Y.encodeStateAsUpdateV2(document));
}

function block(
	name: string,
	text: string,
	attributes: Record<string, string | number | boolean> = {},
): Y.Type {
	const value = new Y.Type(name);
	for (const [key, attribute] of Object.entries(attributes)) {
		value.setAttr(key, attribute);
	}
	if (text.length > 0) value.insert(0, text);
	return value;
}

function createHoneycrispSeed(): Y.Doc {
	const document = new Y.Doc({ gc: true });
	const body = document.get('body');
	const heading = block('heading', 'Project Orchard', { level: 1 });
	const paragraph = block(
		'paragraph',
		'A local-first note edited across a phone, browser, and desktop.',
	);
	paragraph.format(2, 11, { bold: true });
	const taskList = new Y.Type('taskList');
	const taskItem = new Y.Type('taskItem');
	taskItem.setAttr('checked', false);
	taskItem.insert(0, [block('paragraph', 'Review the offline merge')]);
	taskList.insert(0, [taskItem]);
	body.insert(0, [heading, paragraph, taskList]);
	return document;
}

function createOfflineUpdates(seed: Uint8Array): {
	actors: string[];
	updates: Uint8Array[];
} {
	const seedDocument = new Y.Doc({ gc: true });
	Y.applyUpdateV2(seedDocument, seed);
	const seedVector = Y.encodeStateVector(seedDocument);
	seedDocument.destroy();
	const actors = ['phone', 'browser', 'desktop', 'tablet'];
	const updates = actors.map((actor) => {
		const document = new Y.Doc({ gc: true });
		Y.applyUpdateV2(document, seed);
		const body = document.get('body');
		switch (actor) {
			case 'phone': {
				const paragraph = block(
					'paragraph',
					'Captured on the train before the connection returned.',
				);
				paragraph.format(16, 5, { italic: true });
				body.insert(body.length, [paragraph]);
				break;
			}
			case 'browser':
				body.insert(0, [
					block(
						'blockquote',
						'Offline changes remain ordinary document edits.',
					),
				]);
				body.delete(2, 1);
				break;
			case 'desktop': {
				const title = body.get(0);
				if (!(title instanceof Y.Type)) {
					throw new Error('Honeycrisp title block is missing');
				}
				const undoManager = new Y.UndoManager(title, {
					captureTimeout: 0,
				});
				title.insert(title.length, ' draft');
				assertEvidence(
					undoManager.undo() !== null,
					'Honeycrisp undo workload must capture the draft edit',
				);
				title.insert(title.length, ' planning');
				title.format(0, 7, { bold: true });
				undoManager.destroy();
				break;
			}
			case 'tablet': {
				const list = new Y.Type('bulletList');
				list.insert(0, [
					block('listItem', 'Measure exact decoded structure'),
					block('listItem', 'Keep the canonical bytes bounded'),
				]);
				body.insert(body.length, [list]);
				break;
			}
		}
		const update = new Uint8Array(
			Y.encodeStateAsUpdateV2(document, seedVector),
		);
		document.destroy();
		return update;
	});
	return { actors, updates };
}

function permutations(values: readonly number[]): number[][] {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, candidate) => candidate !== index)).map(
			(rest) => [value, ...rest],
		),
	);
}

async function digest(bytes: Uint8Array): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(bytes);
	return hasher.digest('hex');
}

async function realisticOfflineWorkload(): Promise<{
	update: Uint8Array;
	measure: DocumentMeasure;
	actors: string[];
	behaviors: string[];
	permutationCount: number;
	distinctCanonicalDigests: string[];
	actorUpdateBytes: number[];
}> {
	const seedDocument = createHoneycrispSeed();
	const seed = encode(seedDocument);
	seedDocument.destroy();
	const { actors, updates } = createOfflineUpdates(seed);
	const orders = permutations(updates.map((_, index) => index));
	const canonical = new Map<string, Uint8Array>();
	for (const order of orders) {
		const document = new Y.Doc({ gc: true });
		Y.applyUpdateV2(document, seed);
		for (const index of order) {
			const update = updates[index];
			if (update === undefined) throw new Error('offline update is missing');
			Y.applyUpdateV2(document, update);
		}
		const state = encode(document);
		canonical.set(await digest(state), state);
		document.destroy();
	}
	assertEvidence(
		canonical.size === 1,
		'all offline-client application orders must converge byte-for-byte',
	);
	const update = canonical.values().next().value;
	assertEvidence(update instanceof Uint8Array, 'offline state must exist');
	return {
		update,
		measure: measureDocumentState(update),
		actors,
		behaviors: ['typing', 'formatting', 'undo', 'deletion'],
		permutationCount: orders.length,
		distinctCanonicalDigests: [...canonical.keys()],
		actorUpdateBytes: updates.map((candidate) => candidate.byteLength),
	};
}

function structuralWorkload(
	targetStructs: number,
	seed: Uint8Array,
): { update: Uint8Array; measure: DocumentMeasure; densePrepends: number } {
	const document = new Y.Doc({ gc: true });
	Y.applyUpdateV2(document, seed);
	const initial = measureDocumentState(encode(document));
	const densePrepends = targetStructs - initial.stateStructs;
	assertEvidence(
		densePrepends >= 0,
		`target ${targetStructs} must be above the Honeycrisp seed`,
	);
	const adversarial = document.get('adversarial-prepends');
	for (let index = 0; index < densePrepends; index += 1) {
		adversarial.insert(0, String.fromCharCode(97 + (index % 26)));
	}
	const update = encode(document);
	document.destroy();
	const measure = measureDocumentState(update);
	assertEvidence(
		measure.stateStructs === targetStructs,
		`generated ${measure.stateStructs} structs instead of ${targetStructs}`,
	);
	assertEvidence(
		measure.stateBytes <= DOCUMENT_BOUND.stateBytes,
		`structural fixture crossed the byte bound at ${measure.stateBytes} bytes`,
	);
	return { update, measure, densePrepends };
}

function addressQuery(address: RecordAddress): string {
	const query = new URLSearchParams({
		object: OBJECT,
		namespace: address.namespace,
		collection: address.collection,
		recordKey: address.recordKey,
	});
	return query.toString();
}

async function json<T>(
	harness: WorkerdHarness,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await harness.fetch(path, init);
	if (!response.ok) {
		throw new Error(
			`workerd command failed (${response.status}): ${await response.text()}`,
		);
	}
	return (await response.json()) as T;
}

async function publish(
	harness: WorkerdHarness,
	authorityLifetime: string,
	address: RecordAddress,
	payload: Uint8Array,
): Promise<PublicationResult> {
	const body = new ArrayBuffer(payload.byteLength);
	new Uint8Array(body).set(payload);
	const started = performance.now();
	const result = await json<Omit<PublicationResult, 'roundTripMilliseconds'>>(
		harness,
		`/publish?${addressQuery(address)}`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				'x-authority-lifetime': authorityLifetime,
			},
			body,
		},
	);
	return {
		...result,
		roundTripMilliseconds: performance.now() - started,
	};
}

function inspect(
	harness: WorkerdHarness,
	address: RecordAddress,
): Promise<DocumentState> {
	return json(harness, `/inspect?${addressQuery(address)}`);
}

async function sha256(path: string): Promise<string> {
	return digest(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

async function packageVersion(path: string): Promise<string> {
	const value = (await Bun.file(path).json()) as { version?: unknown };
	if (typeof value.version !== 'string') {
		throw new Error(`package version is missing from ${path}`);
	}
	return value.version;
}

async function packageDependencyVersion(
	path: string,
	dependency: string,
): Promise<string> {
	const value = (await Bun.file(path).json()) as {
		dependencies?: Record<string, unknown>;
	};
	const version = value.dependencies?.[dependency];
	if (typeof version !== 'string') {
		throw new Error(`package dependency ${dependency} is missing from ${path}`);
	}
	return version;
}

const outputFlag = process.argv.indexOf('--output');
const output = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
const persistence = mkdtempSync(
	join(tmpdir(), 'epicenter-document-struct-bound-'),
);
const buildDirectory = mkdtempSync(
	join(tmpdir(), 'epicenter-document-struct-bound-code-'),
);
const workerSource = join(import.meta.dir, 'document-struct-bound-worker.ts');
const workerBundle = join(buildDirectory, 'document-struct-bound-worker.js');
let harness: WorkerdHarness | undefined;

function progress(message: string): void {
	process.stderr.write(`[document-struct-bound] ${message}\n`);
}

async function start(): Promise<WorkerdHarness> {
	const worker = new Miniflare({
		compatibilityDate: '2026-03-06',
		durableObjects: {
			DATA_AUTHORITY: {
				className: 'DocumentBoundEvidenceAuthority',
				useSQLite: true,
			},
		},
		durableObjectsPersist: persistence,
		modules: true,
		modulesRoot: buildDirectory,
		r2Buckets: ['DATA_BLOBS'],
		r2Persist: persistence,
		scriptPath: workerBundle,
	});
	await worker.ready;
	return {
		fetch(path, init) {
			return worker.dispatchFetch(
				new URL(path, 'http://document-bound.local'),
				init as never,
			) as unknown as Promise<WorkerdResponse>;
		},
		stop() {
			return worker.dispose();
		},
	};
}

try {
	progress('building the production DataAuthority evidence worker');
	const build = await Bun.build({
		entrypoints: [workerSource],
		external: ['cloudflare:workers'],
		outdir: buildDirectory,
		target: 'browser',
	});
	if (!build.success) {
		throw new AggregateError(build.logs, 'document-bound worker bundle failed');
	}
	const bundleOutput = build.outputs[0]?.path;
	assertEvidence(bundleOutput !== undefined, 'worker bundle output is missing');
	if (bundleOutput !== workerBundle) {
		throw new Error(
			`unexpected worker bundle path: ${bundleOutput} (expected ${workerBundle})`,
		);
	}

	const fingerprints = {
		runnerSha256: await sha256(import.meta.path),
		workerSha256: await sha256(workerSource),
		bundleSha256: await sha256(workerBundle),
		documentAuthoritySha256: await sha256(
			join(import.meta.dir, '../document-authority-v1.ts'),
		),
		dataAuthoritySha256: await sha256(
			join(import.meta.dir, '../scalar-v1-cloudflare.ts'),
		),
		documentProtocolSha256: await sha256(
			join(ROOT, 'packages/sync/src/document-v3/protocol.ts'),
		),
		rootPackageSha256: await sha256(join(ROOT, 'package.json')),
		lockfileSha256: await sha256(join(ROOT, 'bun.lock')),
	};

	progress('generating Honeycrisp and exact structural fixtures');
	const realistic = await realisticOfflineWorkload();
	const seedDocument = createHoneycrispSeed();
	const seed = encode(seedDocument);
	seedDocument.destroy();
	const below = structuralWorkload(DOCUMENT_BOUND.stateStructs - 1, seed);
	const exact = structuralWorkload(DOCUMENT_BOUND.stateStructs, seed);
	const above = structuralWorkload(DOCUMENT_BOUND.stateStructs + 1, seed);
	const inputs = {
		realistic: {
			...realistic,
			update: undefined,
			digest: documentPayloadDigest(realistic.update),
		},
		below: {
			...below,
			update: undefined,
			digest: documentPayloadDigest(below.update),
		},
		exact: {
			...exact,
			update: undefined,
			digest: documentPayloadDigest(exact.update),
		},
		above: {
			...above,
			update: undefined,
			digest: documentPayloadDigest(above.update),
		},
	};

	harness = await start();
	progress('initializing four live production records');
	const initialized = await json<{
		authorityLifetime: string;
		submitted: { data: unknown; error: unknown };
	}>(harness, `/initialize?object=${OBJECT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(Object.values(ADDRESS)),
	});
	assertEvidence(
		initialized.submitted.error === null,
		'live scalar records must initialize',
	);

	progress('publishing realistic and below/exact boundary states');
	const realisticPublication = await publish(
		harness,
		initialized.authorityLifetime,
		ADDRESS.realistic,
		realistic.update,
	);
	assertEvidence(
		realisticPublication.acceptance.kind === 'accepted',
		'realistic offline workload must be accepted',
	);
	const belowPublication = await publish(
		harness,
		initialized.authorityLifetime,
		ADDRESS.below,
		below.update,
	);
	assertEvidence(
		belowPublication.acceptance.kind === 'accepted',
		'bound minus one must be accepted',
	);
	const exactPublication = await publish(
		harness,
		initialized.authorityLifetime,
		ADDRESS.exact,
		exact.update,
	);
	assertEvidence(
		exactPublication.acceptance.kind === 'accepted',
		'exact structural bound must be accepted',
	);

	progress('seeding prior state and refusing bound plus one');
	const priorPublication = await publish(
		harness,
		initialized.authorityLifetime,
		ADDRESS.above,
		seed,
	);
	assertEvidence(
		priorPublication.acceptance.kind === 'accepted',
		'above-bound record prior state must be accepted',
	);
	const beforeRefusal = await inspect(harness, ADDRESS.above);
	const abovePublication = await publish(
		harness,
		initialized.authorityLifetime,
		ADDRESS.above,
		above.update,
	);
	assertEvidence(
		abovePublication.acceptance.kind === 'document-bound',
		'bound plus one must be refused',
	);
	assertEvidence(
		abovePublication.acceptance.measured.stateStructs ===
			DOCUMENT_BOUND.stateStructs + 1,
		'authority refusal must report the exact post-candidate struct count',
	);
	const afterRefusal = await inspect(harness, ADDRESS.above);
	assertEvidence(
		JSON.stringify(afterRefusal) === JSON.stringify(beforeRefusal),
		'refusal must leave document bytes, chain, record revision, and next revision unchanged',
	);

	const acceptedStates = {
		realistic: await inspect(harness, ADDRESS.realistic),
		below: await inspect(harness, ADDRESS.below),
		exact: await inspect(harness, ADDRESS.exact),
	};
	assertEvidence(
		acceptedStates.below.measure?.stateStructs ===
			DOCUMENT_BOUND.stateStructs - 1,
		'workerd must retain bound minus one',
	);
	assertEvidence(
		acceptedStates.exact.measure?.stateStructs === DOCUMENT_BOUND.stateStructs,
		'workerd must retain the exact bound',
	);

	progress('reopening workerd against the same Durable Object SQLite');
	await harness.stop();
	harness = undefined;
	const reopenStarted = performance.now();
	harness = await start();
	const processReopenMilliseconds = performance.now() - reopenStarted;
	const reopened = {
		realistic: await inspect(harness, ADDRESS.realistic),
		below: await inspect(harness, ADDRESS.below),
		exact: await inspect(harness, ADDRESS.exact),
		above: await inspect(harness, ADDRESS.above),
	};
	assertEvidence(
		JSON.stringify(reopened.realistic) ===
			JSON.stringify(acceptedStates.realistic),
		'realistic state must survive workerd reopen',
	);
	assertEvidence(
		JSON.stringify(reopened.below) === JSON.stringify(acceptedStates.below),
		'bound minus one must survive workerd reopen',
	);
	assertEvidence(
		JSON.stringify(reopened.exact) === JSON.stringify(acceptedStates.exact),
		'exact bound must survive workerd reopen',
	);
	assertEvidence(
		JSON.stringify(reopened.above) === JSON.stringify(beforeRefusal),
		'refused record prior state must survive workerd reopen',
	);

	const report = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		claim:
			'Production DataAuthority accepts exactly 131072 decoded structs and atomically refuses 131073 without changing prior state.',
		environment: {
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model ?? 'unknown',
			bun: Bun.version,
			miniflare: await packageVersion(
				join(ROOT, 'node_modules/miniflare/package.json'),
			),
			workerd: await packageDependencyVersion(
				join(ROOT, 'node_modules/miniflare/package.json'),
				'workerd',
			),
			compatibilityDate: '2026-03-06',
		},
		bound: DOCUMENT_BOUND,
		fingerprints,
		inputs,
		results: {
			realistic: {
				publication: realisticPublication,
				state: acceptedStates.realistic,
			},
			below: {
				publication: belowPublication,
				state: acceptedStates.below,
			},
			exact: {
				publication: exactPublication,
				state: acceptedStates.exact,
			},
			above: {
				priorInput: {
					digest: documentPayloadDigest(seed),
					measure: measureDocumentState(seed),
				},
				priorPublication,
				beforeRefusal,
				publication: abovePublication,
				afterRefusal,
			},
			reopen: {
				processReopenMilliseconds,
				state: reopened,
			},
		},
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (output === undefined) process.stdout.write(serialized);
	else {
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, serialized);
		progress(`wrote ${output}`);
	}
} finally {
	await harness?.stop();
	rmSync(persistence, { recursive: true, force: true });
	rmSync(buildDirectory, { recursive: true, force: true });
}

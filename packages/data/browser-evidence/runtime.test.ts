/**
 * Production Browser Runtime Tests
 *
 * Exercises the W4 record-handle runtime through the elected dedicated-worker
 * owner topology in Chromium and WebKit.
 *
 * Key behaviors:
 * - Scalar, document, and blob writes survive runtime close and reopen
 * - whenDurable waits for the elected owner's document append result
 * - Offline obligations survive reopen and drain independently on reconnect
 * - Delayed document acceptance cannot settle a newer local revision
 * - Shared documents, unset/tombstone lifecycle, and disposal stay coherent
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
	type BrowserContext,
	type BrowserType,
	chromium,
	type Page,
	webkit,
} from 'playwright';

import type { RecordAddress } from '../src/protocol/v1/index.js';
import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import type { BrowserReplicaCandidateStart } from '../src/store/replica/browser-candidate-protocol.js';
import type { BrowserReplicaStoreOperation } from '../src/store/replica/browser-owner-protocol.js';
import type { DocumentInspection } from '../src/store/replica/index.js';

setDefaultTimeout(60_000);
const evidenceDir = import.meta.dirname;
const distDir = resolve(evidenceDir, 'dist');
const profileDirectory = mkdtempSync(
	resolve(tmpdir(), 'epicenter-browser-runtime-'),
);

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
	{ cwd: evidenceDir, stdout: 'inherit', stderr: 'inherit' },
);
if (!build.success) throw new Error('Browser runtime evidence build failed');

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
		const target = resolve(distDir, `.${decodeURIComponent(pathname)}`);
		if (target !== distDir && !target.startsWith(`${distDir}${sep}`)) {
			return new Response('Forbidden', { status: 403 });
		}
		const file = Bun.file(target);
		if (!(await file.exists()) || !statSync(target).isFile()) {
			return new Response('Not found', { status: 404 });
		}
		return new Response(file, {
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin',
			},
		});
	},
});

let chromiumContext: BrowserContext | undefined;
let chromiumPage: Page | undefined;
let webkitContext: BrowserContext | undefined;
let webkitPage: Page | undefined;

async function openEngine(
	engine: BrowserType,
	name: string,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await engine.launchPersistentContext(
		resolve(profileDirectory, name),
		{ headless: true },
	);
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.waitForFunction(
		() =>
			window.browserRuntimeEvidence !== undefined &&
			window.browserReplicaCandidateEvidence !== undefined,
	);
	return { context, page };
}

beforeAll(async () => {
	const chromiumOpened = await openEngine(chromium, 'chromium');
	chromiumContext = chromiumOpened.context;
	chromiumPage = chromiumOpened.page;
	const webkitOpened = await openEngine(webkit, 'webkit');
	webkitContext = webkitOpened.context;
	webkitPage = webkitOpened.page;
});

afterAll(async () => {
	await Promise.allSettled([chromiumContext?.close(), webkitContext?.close()]);
	server.stop(true);
	rmSync(profileDirectory, { recursive: true, force: true });
});

function requirePage(read: () => Page | undefined): Page {
	const page = read();
	if (page === undefined) throw new Error('browser runtime page is not ready');
	return page;
}

async function waitForSettled(page: Page, ids: string[]): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const settled = await page.evaluate(async (recordIds) => {
			for (const id of recordIds) {
				if (
					(await window.browserRuntimeEvidence.publication(id)).state !==
					'settled'
				) {
					return false;
				}
			}
			return window.browserRuntimeEvidence.status().state === 'idle';
		}, ids);
		if (settled) return;
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for browser runtime settlement');
		}
		await Bun.sleep(25);
	}
}

async function runRuntimeCheckpoint(page: Page, engineName: string) {
	const storageId = crypto.randomUUID();
	const options = {
		coordinationId: `epicenter-runtime-${storageId}`,
		storage: {
			databaseFilename: '/replica.sqlite3',
			poolDirectory: `.epicenter-runtime-${storageId}`,
			poolName: `epicenter-runtime-${storageId}`,
		},
	};
	const discardOptions = {
		coordinationId: `epicenter-runtime-discard-${storageId}`,
		replicaId: 'dddddddddddddddddddddddd',
		storage: {
			databaseFilename: '/discard.sqlite3',
			poolDirectory: `.epicenter-runtime-discard-${storageId}`,
			poolName: `epicenter-runtime-discard-${storageId}`,
		},
	};
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		discardOptions,
	);
	const discardedId = await page.evaluate(async () => {
		const runtime = window.browserRuntimeEvidence;
		const id = await runtime.create('discard before first attachment');
		await runtime.openDocument('discarded', id);
		runtime.insertDocument('discarded', 0, 'discarded lineage');
		await runtime.whenDocumentDurable('discarded');
		return id;
	});
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('first-attachment-choice');
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach('discard')),
	).toBe('attached');
	expect(
		await page.evaluate(() => {
			try {
				window.browserRuntimeEvidence.documentText('discarded');
				return false;
			} catch {
				return true;
			}
		}),
	).toBeTrue();
	expect(
		await page.evaluate(
			(id) => window.browserRuntimeEvidence.get(id),
			discardedId,
		),
	).toBeNull();
	await page.evaluate(async () => {
		await window.browserRuntimeEvidence.closeDocument('discarded');
		await window.browserRuntimeEvidence.dispose();
	});

	const heldDisposalOptions = {
		coordinationId: `epicenter-runtime-held-disposal-${storageId}`,
		replicaId: 'hhhhhhhhhhhhhhhhhhhhhhhh',
		storage: {
			databaseFilename: '/held-disposal.sqlite3',
			poolDirectory: `.epicenter-runtime-held-disposal-${storageId}`,
			poolName: `epicenter-runtime-held-disposal-${storageId}`,
		},
	};
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		heldDisposalOptions,
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('attached');
	const heldDisposalId = await page.evaluate(() =>
		window.browserRuntimeEvidence.create('dispose during carrier request'),
	);
	await waitForSettled(page, [heldDisposalId]);
	const beforeHeldDisposal = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(async (id) => {
		const runtime = window.browserRuntimeEvidence;
		await runtime.openDocument('held-disposal', id);
		runtime.holdDocumentReceipts();
		runtime.insertDocument('held-disposal', 0, 'held authority call');
		await runtime.whenDocumentDurable('held-disposal');
	}, heldDisposalId);
	await page.waitForFunction(
		(count) =>
			window.browserRuntimeEvidence.authorityCounts().documents > count,
		beforeHeldDisposal.documents,
	);
	await page.evaluate(() =>
		window.browserRuntimeEvidence.beginDisposeRuntimeKeepingDocuments(),
	);
	await Bun.sleep(50);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.disposalSettled()),
	).toBeFalse();
	await page.evaluate(() =>
		window.browserRuntimeEvidence.releaseDocumentReceipts(),
	);
	await page.evaluate(() => window.browserRuntimeEvidence.waitForDisposal());
	expect(
		await page.evaluate(() => {
			try {
				window.browserRuntimeEvidence.documentText('held-disposal');
				return false;
			} catch {
				return true;
			}
		}),
	).toBeTrue();
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());

	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		options,
	);

	const firstId = await page.evaluate(() =>
		window.browserRuntimeEvidence.create('before attachment'),
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('first-attachment-choice');

	await page.evaluate((id) => {
		const runtime = window.browserRuntimeEvidence;
		return runtime
			.openDocument('first', id)
			.then(() => runtime.openDocument('second', id))
			.then(() => {
				runtime.holdDocumentAcknowledgements();
				runtime.insertDocument('first', 0, 'owner durable');
				runtime.beginDocumentDurability('second');
			});
	}, firstId);
	expect(
		await page.evaluate(() =>
			window.browserRuntimeEvidence.documentText('second'),
		),
	).toBe('owner durable');
	await page.waitForFunction(() =>
		window.browserRuntimeEvidence.documentAcknowledgementHeld(),
	);
	expect(
		await page.evaluate(() =>
			window.browserRuntimeEvidence.documentDurabilitySettled(),
		),
	).toBeFalse();
	await page.evaluate(() =>
		window.browserRuntimeEvidence.releaseDocumentAcknowledgements(),
	);
	await page.evaluate(() =>
		window.browserRuntimeEvidence.waitForDocumentDurability(),
	);
	await page.evaluate(
		(id) => window.browserRuntimeEvidence.captureBlob(id, 'immutable bytes'),
		firstId,
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach('bring')),
	).toBe('attached');

	await page.evaluate(
		(candidateOptions) =>
			window.browserReplicaCandidateEvidence.open(candidateOptions),
		{
			limits: makeLimits(),
			initialize: {
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'runtime-life',
			},
			hasCarrier: false,
			...options,
		} satisfies Omit<BrowserReplicaCandidateStart, 'type'>,
	);
	const address: RecordAddress = {
		namespace: 'so.epicenter.browser-runtime',
		collection: 'notes',
		recordKey: firstId,
	};
	const inspection = (await page.evaluate(
		(operation) =>
			window.browserReplicaCandidateEvidence.request(
				operation as BrowserReplicaStoreOperation,
			),
		{ kind: 'inspect-document', address },
	)) as DocumentInspection;
	expect(inspection.revision).toBe(1);
	await page.evaluate(() => window.browserReplicaCandidateEvidence.close());

	await page.evaluate(async () => {
		await window.browserRuntimeEvidence.closeDocument('first');
		await window.browserRuntimeEvidence.closeDocument('second');
		await window.browserRuntimeEvidence.dispose();
	});
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		options,
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('attached');
	expect(
		await page.evaluate((id) => window.browserRuntimeEvidence.get(id), firstId),
	).toMatchObject({ id: firstId, title: 'before attachment' });
	await page.evaluate(
		(id) => window.browserRuntimeEvidence.openDocument('reopened', id),
		firstId,
	);
	expect(
		await page.evaluate(() =>
			window.browserRuntimeEvidence.documentText('reopened'),
		),
	).toBe('owner durable');
	expect(
		await page.evaluate(
			(id) => window.browserRuntimeEvidence.readBlob(id),
			firstId,
		),
	).toBe('immutable bytes');
	await page.evaluate(() =>
		window.browserRuntimeEvidence.closeDocument('reopened'),
	);

	await page.evaluate(() => window.browserRuntimeEvidence.setOnline(false));
	const offlineIds = await page.evaluate(async () => {
		const runtime = window.browserRuntimeEvidence;
		const scalar = await runtime.create('offline scalar');
		const document = await runtime.create('offline document');
		const blob = await runtime.create('offline blob');
		await runtime.openDocument('offline', document);
		runtime.insertDocument('offline', 0, 'offline edit');
		await runtime.whenDocumentDurable('offline');
		await runtime.closeDocument('offline');
		await runtime.captureBlob(blob, 'offline bytes');
		return { scalar, document, blob };
	});
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		options,
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('attached');
	for (const id of Object.values(offlineIds)) {
		expect(
			await page.evaluate(
				(recordId) => window.browserRuntimeEvidence.publication(recordId),
				id,
			),
		).toMatchObject({ state: 'ready' });
	}
	await page.evaluate(
		(id) => window.browserRuntimeEvidence.openDocument('offline-reopen', id),
		offlineIds.document,
	);
	expect(
		await page.evaluate(() =>
			window.browserRuntimeEvidence.documentText('offline-reopen'),
		),
	).toBe('offline edit');
	await page.evaluate(() =>
		window.browserRuntimeEvidence.closeDocument('offline-reopen'),
	);
	expect(
		await page.evaluate(
			(id) => window.browserRuntimeEvidence.readBlob(id),
			offlineIds.blob,
		),
	).toBe('offline bytes');

	const beforeReconnect = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(() => {
		window.browserRuntimeEvidence.setOnline(true);
		window.browserRuntimeEvidence.nudgeOnline();
	});
	await waitForSettled(page, Object.values(offlineIds));
	const afterReconnect = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	expect(afterReconnect.submissions).toBeGreaterThan(
		beforeReconnect.submissions,
	);
	expect(afterReconnect.documents).toBeGreaterThan(beforeReconnect.documents);
	expect(afterReconnect.blobs).toBeGreaterThan(beforeReconnect.blobs);

	await page.evaluate(() => window.browserRuntimeEvidence.setOnline(false));
	const reopenOnlineId = await page.evaluate(() =>
		window.browserRuntimeEvidence.create('owed across online reopen'),
	);
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());
	await page.evaluate(() => window.browserRuntimeEvidence.setOnline(true));
	const beforeOnlineReopen = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		options,
	);
	await waitForSettled(page, [reopenOnlineId]);
	expect(
		(await page.evaluate(() => window.browserRuntimeEvidence.authorityCounts()))
			.submissions,
	).toBeGreaterThan(beforeOnlineReopen.submissions);

	await page.evaluate(
		(id) => window.browserRuntimeEvidence.openDocument('racing', id),
		offlineIds.document,
	);
	const beforeRace = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(() => {
		const runtime = window.browserRuntimeEvidence;
		runtime.holdDocumentReceipts();
		runtime.insertDocument('racing', 12, ' one');
		return runtime.whenDocumentDurable('racing');
	});
	await page.waitForFunction(
		(count) =>
			window.browserRuntimeEvidence.authorityCounts().documents > count,
		beforeRace.documents,
	);
	await page.evaluate(() => {
		const runtime = window.browserRuntimeEvidence;
		runtime.insertDocument('racing', 16, ' two');
		return runtime.whenDocumentDurable('racing');
	});
	await page.evaluate(() =>
		window.browserRuntimeEvidence.releaseDocumentReceipts(),
	);
	await page.waitForFunction(
		(count) =>
			window.browserRuntimeEvidence.authorityCounts().documents >= count + 2,
		beforeRace.documents,
	);
	await waitForSettled(page, [offlineIds.document]);
	expect(
		await page.evaluate(() =>
			window.browserRuntimeEvidence.documentText('racing'),
		),
	).toBe('offline edit one two');

	await page.evaluate(
		(candidateOptions) =>
			window.browserReplicaCandidateEvidence.open(candidateOptions),
		{
			limits: makeLimits(),
			initialize: {
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'runtime-life',
			},
			hasCarrier: false,
			...options,
		} satisfies Omit<BrowserReplicaCandidateStart, 'type'>,
	);
	await page.evaluate(
		(operation) =>
			window.browserReplicaCandidateEvidence.request(
				operation as BrowserReplicaStoreOperation,
			),
		{
			kind: 'local-write',
			intent: {
				address: {
					namespace: 'so.epicenter.browser-runtime',
					collection: 'notes',
					recordKey: offlineIds.document,
				},
				op: 'unset',
			},
		},
	);
	await page.waitForFunction(
		() =>
			window.browserRuntimeEvidence.documentText('racing') ===
			'offline edit one two',
	);
	await page.evaluate(
		(operation) =>
			window.browserReplicaCandidateEvidence.request(
				operation as BrowserReplicaStoreOperation,
			),
		{
			kind: 'local-write',
			intent: {
				address: {
					namespace: 'so.epicenter.browser-runtime',
					collection: 'notes',
					recordKey: offlineIds.document,
				},
				op: 'tombstone',
			},
		},
	);
	await page.waitForFunction(() => {
		try {
			window.browserRuntimeEvidence.documentText('racing');
			return false;
		} catch {
			return true;
		}
	});

	await page.evaluate(() => window.browserReplicaCandidateEvidence.close());
	await page.evaluate(async () => {
		const runtime = window.browserRuntimeEvidence;
		const id = await runtime.create('authority replacement');
		await runtime.openDocument('authority', id);
		runtime.insertDocument('authority', 0, 'old lineage');
		await runtime.whenDocumentDurable('authority');
		runtime.replaceAuthority('replacement-life');
		runtime.nudgeOnline();
	});
	await page.waitForFunction(() => {
		try {
			window.browserRuntimeEvidence.documentText('authority');
			return false;
		} catch {
			return true;
		}
	});
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.attach()),
	).toBe('attached');

	const disposalRecord = await page.evaluate(async () => {
		const runtime = window.browserRuntimeEvidence;
		const id = await runtime.create('dispose with live document');
		await runtime.openDocument('dispose-live', id);
		runtime.insertDocument('dispose-live', 0, 'release me');
		await runtime.whenDocumentDurable('dispose-live');
		return id;
	});
	await waitForSettled(page, [disposalRecord]);
	const beforeDispose = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(() =>
		window.browserRuntimeEvidence.disposeRuntimeKeepingDocuments(),
	);
	expect(
		await page.evaluate(() => {
			try {
				window.browserRuntimeEvidence.documentText('dispose-live');
				return false;
			} catch {
				return true;
			}
		}),
	).toBeTrue();
	await Bun.sleep(750);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.authorityCounts()),
	).toEqual(beforeDispose);
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());
	console.log(`${engineName}: W4 browser runtime checkpoint passed`);
}

test('Chromium runs W4 through the production elected owner', async () => {
	await runRuntimeCheckpoint(
		requirePage(() => chromiumPage),
		'chromium',
	);
});

test('WebKit runs W4 through the production elected owner', async () => {
	await runRuntimeCheckpoint(
		requirePage(() => webkitPage),
		'webkit',
	);
});

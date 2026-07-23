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
	const OWNER = {
		deploymentId: 'https://example.test/',
		principalId: 'principal-evidence',
	};
	function slotOptions(prefix: string) {
		const name = `epicenter-runtime-${prefix}-${storageId}`;
		return {
			coordinationId: name,
			storage: {
				databaseFilename: '/replica.sqlite3',
				poolDirectory: `.${name}`,
				poolName: name,
				lockName: name,
				blobDirectory: `${name}-blobs`,
			},
		};
	}
	const mainSlot = slotOptions('main');
	const mainSignedOut = { ...mainSlot, owner: OWNER, withCarrier: false };
	const mainSignedIn = { ...mainSlot, owner: OWNER, withCarrier: true };

	// An unclaimed replica is permanently local-only: writes stay durable, no
	// authority contact happens, identity cannot be reassigned, and an elected
	// replacement while signed out stays local-only (ADR-0178).
	const unclaimedSlot = slotOptions('unclaimed');
	const unclaimedOptions = {
		...unclaimedSlot,
		replicaId: 'dddddddddddddddddddddddd',
		owner: null,
	};
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		unclaimedOptions,
	);
	const unclaimedId = await page.evaluate(async () => {
		const runtime = window.browserRuntimeEvidence;
		const id = await runtime.create('unclaimed local data');
		await runtime.openDocument('unclaimed', id);
		runtime.insertDocument('unclaimed', 0, 'unclaimed lineage');
		await runtime.whenDocumentDurable('unclaimed');
		await runtime.closeDocument('unclaimed');
		return id;
	});
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.status().state),
	).toBe('local-only');
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());

	// Opening the same physical replica under another identity fails without
	// mutating it.
	await expect(
		page.evaluate(
			(value) => window.browserRuntimeEvidence.open(value),
			{ ...unclaimedOptions, owner: OWNER },
		),
	).rejects.toThrow(/identity does not match/);

	// Same-identity reopen finds the data intact.
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		unclaimedOptions,
	);
	expect(
		await page.evaluate(
			(id) => window.browserRuntimeEvidence.get(id),
			unclaimedId,
		),
	).toMatchObject({ id: unclaimedId, title: 'unclaimed local data' });

	// A second candidate on the same slot takes over after the first owner
	// leaves and reconstructs the same local-only posture: no worker-local
	// sign-in memory exists to lose.
	await page.evaluate(
		(candidateOptions) =>
			window.browserReplicaCandidateEvidence.open(candidateOptions),
		{
			limits: makeLimits(),
			owner: null,
			initialize: { replicaId: 'dddddddddddddddddddddddd' },
			hasCarrier: false,
			coordinationId: unclaimedOptions.coordinationId,
			storage: unclaimedOptions.storage,
		} satisfies Omit<BrowserReplicaCandidateStart, 'type'>,
	);
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());
	{
		const deadline = Date.now() + 20_000;
		for (;;) {
			const role = await page.evaluate(
				() => window.browserReplicaCandidateEvidence.status().role,
			);
			if (role === 'owner') break;
			if (Date.now() >= deadline) {
				throw new Error('takeover candidate never became the elected owner');
			}
			await Bun.sleep(50);
		}
	}
	expect(
		(await page.evaluate(
			(operation) =>
				window.browserReplicaCandidateEvidence.request(
					operation as BrowserReplicaStoreOperation,
				),
			{ kind: 'runtime-status' },
		)) as { state: string },
	).toMatchObject({ state: 'local-only' });
	expect(
		(await page.evaluate(
			(operation) =>
				window.browserReplicaCandidateEvidence.request(
					operation as BrowserReplicaStoreOperation,
				),
			{
				kind: 'visible-record',
				address: {
					namespace: 'so.epicenter.browser-runtime',
					collection: 'notes',
					recordKey: unclaimedId,
				},
			},
		)) as { state: string },
	).toMatchObject({ state: 'live' });

	// Retirement refuses while the elected owner still holds the slot, and
	// removes the whole store once released; a later open finds a fresh
	// replica.
	const retireStorage = {
		poolDirectory: unclaimedOptions.storage.poolDirectory,
		lockName: unclaimedOptions.storage.lockName,
		blobDirectory: unclaimedOptions.storage.blobDirectory,
	};
	expect(
		await page.evaluate(
			(storage) => window.browserRuntimeEvidence.retireUnclaimed(storage),
			retireStorage,
		),
	).toBe('held');
	await page.evaluate(() => window.browserReplicaCandidateEvidence.close());
	{
		const deadline = Date.now() + 20_000;
		for (;;) {
			const outcome = await page.evaluate(
				(storage) => window.browserRuntimeEvidence.retireUnclaimed(storage),
				retireStorage,
			);
			if (outcome === 'retired') break;
			if (Date.now() >= deadline) {
				throw new Error('unclaimed retirement never acquired the slot');
			}
			await Bun.sleep(50);
		}
	}
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		unclaimedOptions,
	);
	expect(
		await page.evaluate(
			(id) => window.browserRuntimeEvidence.get(id),
			unclaimedId,
		),
	).toBeNull();
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());

	const heldDisposalOptions = {
		...slotOptions('held-disposal'),
		replicaId: 'hhhhhhhhhhhhhhhhhhhhhhhh',
		owner: OWNER,
		withCarrier: true,
	};
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		heldDisposalOptions,
	);
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

	// The main slot: an account replica opened signed out records durable work
	// that a later signed-in open of the same replica drains.
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		mainSignedOut,
	);

	const firstId = await page.evaluate(() =>
		window.browserRuntimeEvidence.create('before sign-in'),
	);
	expect(
		await page.evaluate(() => window.browserRuntimeEvidence.status().state),
	).toBe('local-only');

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

	await page.evaluate(
		(candidateOptions) =>
			window.browserReplicaCandidateEvidence.open(candidateOptions),
		{
			limits: makeLimits(),
			owner: OWNER,
			initialize: {
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'runtime-life',
			},
			hasCarrier: false,
			coordinationId: mainSlot.coordinationId,
			storage: mainSlot.storage,
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
	// Same-identity signed-out reopen finds everything intact and still owed.
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		mainSignedOut,
	);
	expect(
		await page.evaluate((id) => window.browserRuntimeEvidence.get(id), firstId),
	).toMatchObject({ id: firstId, title: 'before sign-in' });
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
		mainSignedOut,
	);
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

	// Sign-in is a new runtime lifetime over the same replica; the initial
	// drain publishes every retained obligation.
	const beforeReconnect = await page.evaluate(() =>
		window.browserRuntimeEvidence.authorityCounts(),
	);
	await page.evaluate(() => window.browserRuntimeEvidence.dispose());
	await page.evaluate(
		(value) => window.browserRuntimeEvidence.open(value),
		mainSignedIn,
	);
	await waitForSettled(page, [firstId, ...Object.values(offlineIds)]);
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
		mainSignedIn,
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
			owner: OWNER,
			initialize: {
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'runtime-life',
			},
			hasCarrier: false,
			coordinationId: mainSlot.coordinationId,
			storage: mainSlot.storage,
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
	// The replacement lifetime rehydrates automatically; no reattachment
	// operation exists to confirm.
	await waitForSettled(page, []);

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

/**
 * Split Browser Replica Conformance Tests
 *
 * Binds the maintained replica transition cases to the split replica store's
 * direct OPFS ownership, reopen, crash-recovery, and cleanup path in Chromium
 * and WebKit.
 *
 * Key behaviors:
 * - Ordinary semantic reads and commits execute against the split OPFS store
 * - Statement-boundary crashes recover the pre-transition logical state
 * - Physical snapshots cover all split relations without exposing row ids
 */
import { afterAll, beforeAll, setDefaultTimeout } from 'bun:test';
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
import {
	type ConformanceReplica,
	type CrashedReplica,
	type FactsPage,
	type RecordLanes,
	type ReplicaConformanceBinding,
	type ReplicaObservations,
	type ReplicaSync,
	type ReplicaTransition,
	runReplicaConformanceCases,
	type SealWitness,
} from '../src/store/conformance/replica-cases.test-support.js';
import type {
	BrowserReplicaAction,
	BrowserReplicaAnalysis,
	BrowserReplicaObservation,
	BrowserReplicaStorageIdentity,
} from './replica-conformance-contract.js';

const evidenceDir = import.meta.dirname;
setDefaultTimeout(30_000);
const distDir = resolve(evidenceDir, 'dist');
const profileDirectory = mkdtempSync(
	resolve(tmpdir(), 'epicenter-browser-split-conformance-'),
);

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
	{ cwd: evidenceDir, stdout: 'inherit', stderr: 'inherit' },
);
if (!build.success)
	throw new Error('Browser split replica conformance build failed');

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
	return { context, page: await openEvidencePage(context) };
}

async function openEvidencePage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.waitForFunction(
		() => window.browserSplitReplicaConformanceEvidence !== undefined,
	);
	return page;
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
	if (page === undefined)
		throw new Error('browser split conformance page is not ready');
	return page;
}

function createDriver(readPage: () => Page | undefined) {
	let nextCrashedId = 0;
	const crashedPages = new Map<number, Page>();

	async function openStorage(
		page: Page,
		storage: BrowserReplicaStorageIdentity,
		databaseBytes?: number[],
	): Promise<void> {
		await page.evaluate(
			({ storage, databaseBytes }) =>
				window.browserSplitReplicaConformanceEvidence.openStorage(
					storage,
					undefined,
					databaseBytes,
				),
			{ storage, databaseBytes },
		);
	}

	async function observeOn(page: Page, observation: BrowserReplicaObservation) {
		return page.evaluate(
			(observationJson) =>
				window.browserSplitReplicaConformanceEvidence.observe(
					JSON.parse(observationJson) as BrowserReplicaObservation,
				),
			JSON.stringify(observation),
		);
	}

	return {
		open(fixture: { replicaId: string; authorityLifetime?: string }) {
			return requirePage(readPage).evaluate(
				(fixture) =>
					window.browserSplitReplicaConformanceEvidence.open(fixture),
				fixture,
			);
		},
		observe(observation: BrowserReplicaObservation) {
			return observeOn(requirePage(readPage), observation);
		},
		analyze(action: BrowserReplicaAction) {
			return requirePage(readPage).evaluate(
				(actionJson) =>
					window.browserSplitReplicaConformanceEvidence.analyze(
						JSON.parse(actionJson) as BrowserReplicaAction,
					),
				JSON.stringify(action),
			);
		},
		commit(action: BrowserReplicaAction) {
			return requirePage(readPage).evaluate(
				(actionJson) =>
					window.browserSplitReplicaConformanceEvidence.commit(
						JSON.parse(actionJson) as BrowserReplicaAction,
					),
				JSON.stringify(action),
			);
		},
		async crash(action: BrowserReplicaAction, boundary: number) {
			const mainPage = requirePage(readPage);
			const databaseBytes = await mainPage.evaluate(() =>
				window.browserSplitReplicaConformanceEvidence.exportDatabase(),
			);
			const storageId = crypto.randomUUID();
			const storage: BrowserReplicaStorageIdentity = {
				databaseFilename: '/replica.sqlite3',
				poolDirectory: `.epicenter-split-replica-conformance-crash-${storageId}`,
				poolName: `epicenter-split-replica-conformance-crash-${storageId}`,
			};
			const crashingPage = await openEvidencePage(mainPage.context());
			await openStorage(crashingPage, storage, databaseBytes);
			await crashingPage.evaluate(
				({ actionJson, boundary }) =>
					window.browserSplitReplicaConformanceEvidence.crashCurrent(
						JSON.parse(actionJson) as BrowserReplicaAction,
						boundary,
					),
				{ actionJson: JSON.stringify(action), boundary },
			);
			await crashingPage.close();

			const recoveredPage = await openEvidencePage(mainPage.context());
			await openStorage(recoveredPage, storage);
			const crashedId = nextCrashedId++;
			crashedPages.set(crashedId, recoveredPage);
			return crashedId;
		},
		observeCrashed(crashedId: number, observation: BrowserReplicaObservation) {
			const page = crashedPages.get(crashedId);
			if (page === undefined)
				throw new Error('crashed browser split replica is closed');
			return observeOn(page, observation);
		},
		async closeCrashed(crashedId: number) {
			const page = crashedPages.get(crashedId);
			if (page === undefined) return;
			crashedPages.delete(crashedId);
			try {
				await page.evaluate(() =>
					window.browserSplitReplicaConformanceEvidence.closeCurrent(true),
				);
			} finally {
				await page.close();
			}
		},
		reopen() {
			return requirePage(readPage).evaluate(() =>
				window.browserSplitReplicaConformanceEvidence.reopen(),
			);
		},
		async dispose() {
			for (const crashedId of [...crashedPages.keys()]) {
				await this.closeCrashed(crashedId);
			}
			await requirePage(readPage).evaluate(() =>
				window.browserSplitReplicaConformanceEvidence.dispose(),
			);
		},
	};
}

type Driver = ReturnType<typeof createDriver>;

function observations(driver: Driver, crashedId?: number): ReplicaObservations {
	function observe(observation: BrowserReplicaObservation) {
		return crashedId === undefined
			? driver.observe(observation)
			: driver.observeCrashed(crashedId, observation);
	}
	return {
		record: (address: RecordAddress) =>
			observe({ kind: 'record', address }) as Promise<RecordLanes | null>,
		sync: () => observe({ kind: 'sync' }) as Promise<ReplicaSync>,
		sealedRequest: () =>
			observe({ kind: 'sealed-request' }) as Promise<SealWitness | null>,
		snapshot: () => observe({ kind: 'snapshot' }) as Promise<string>,
	};
}

function transition(
	driver: Driver,
	action: BrowserReplicaAction,
	analysis: BrowserReplicaAnalysis,
): ReplicaTransition {
	return {
		boundaries: analysis.boundaries,
		async crash(boundary): Promise<CrashedReplica> {
			const crashedId = await driver.crash(action, boundary);
			return {
				...observations(driver, crashedId),
				close: () => driver.closeCrashed(crashedId),
			};
		},
		async commit() {
			const result = await driver.commit(action);
			if (
				action.kind === 'seal' &&
				JSON.stringify(result) !== JSON.stringify(analysis.result)
			) {
				throw new Error(
					'browser split replica did not commit the analyzed seal witness',
				);
			}
		},
	};
}

function conformanceReplica(driver: Driver): ConformanceReplica {
	async function prepare(action: BrowserReplicaAction) {
		const analysis = await driver.analyze(action);
		return transition(driver, action, analysis);
	}
	return {
		...observations(driver),
		localWrite: (intent) => prepare({ kind: 'local-write', intent }),
		async seal() {
			const action = { kind: 'seal' } as const;
			const analysis = await driver.analyze(action);
			const witness = analysis.result;
			if (analysis.error !== undefined) {
				const error = new Error(analysis.error.message);
				error.name = analysis.error.name;
				throw error;
			}
			if (witness === undefined)
				throw new Error('browser split seal analysis returned no witness');
			return {
				transition: transition(driver, action, analysis),
				requestBytes: witness.bytes,
				requestHash: witness.hash,
			};
		},
		settle: (response) => prepare({ kind: 'settle', response }),
		installFacts: (page: FactsPage) => prepare({ kind: 'install-facts', page }),
		erase: () => prepare({ kind: 'erase' }),
		reconstructSealedRequest: () =>
			driver.observe({ kind: 'reconstruct-sealed-request' }) as Promise<string>,
		async reopen() {
			await driver.reopen();
			return conformanceReplica(driver);
		},
		dispose: () => driver.dispose(),
	};
}

function createBinding(
	name: string,
	readPage: () => Page | undefined,
): ReplicaConformanceBinding {
	const driver = createDriver(readPage);
	return {
		name,
		async create(fixture) {
			await driver.open(fixture);
			return conformanceReplica(driver);
		},
	};
}

runReplicaConformanceCases(
	createBinding('split browser replica store (Chromium)', () => chromiumPage),
);
runReplicaConformanceCases(
	createBinding('split browser replica store (WebKit)', () => webkitPage),
);

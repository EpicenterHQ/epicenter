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
	resolve(tmpdir(), 'epicenter-browser-conformance-'),
);

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
	{ cwd: evidenceDir, stdout: 'inherit', stderr: 'inherit' },
);
if (!build.success) throw new Error('Browser replica conformance build failed');

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
		() => window.browserReplicaConformanceEvidence !== undefined,
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
		throw new Error('browser conformance page is not ready');
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
				window.browserReplicaConformanceEvidence.openStorage(
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
				window.browserReplicaConformanceEvidence.observe(
					JSON.parse(observationJson) as BrowserReplicaObservation,
				),
			JSON.stringify(observation),
		);
	}

	return {
		open(fixture: { replicaId: string; authorityLifetime?: string }) {
			return requirePage(readPage).evaluate(
				(fixture) => window.browserReplicaConformanceEvidence.open(fixture),
				fixture,
			);
		},
		observe(observation: BrowserReplicaObservation) {
			return observeOn(requirePage(readPage), observation);
		},
		analyze(action: BrowserReplicaAction) {
			return requirePage(readPage).evaluate(
				(actionJson) =>
					window.browserReplicaConformanceEvidence.analyze(
						JSON.parse(actionJson) as BrowserReplicaAction,
					),
				JSON.stringify(action),
			);
		},
		commit(action: BrowserReplicaAction) {
			return requirePage(readPage).evaluate(
				(actionJson) =>
					window.browserReplicaConformanceEvidence.commit(
						JSON.parse(actionJson) as BrowserReplicaAction,
					),
				JSON.stringify(action),
			);
		},
		async crash(action: BrowserReplicaAction, boundary: number) {
			const mainPage = requirePage(readPage);
			const databaseBytes = await mainPage.evaluate(() =>
				window.browserReplicaConformanceEvidence.exportDatabase(),
			);
			const storage: BrowserReplicaStorageIdentity = {
				databaseFilename: '/replica.sqlite3',
				poolDirectory: `.epicenter-replica-conformance-crash-${crypto.randomUUID()}`,
				poolName: `epicenter-replica-conformance-crash-${crypto.randomUUID()}`,
			};
			const crashingPage = await openEvidencePage(mainPage.context());
			await openStorage(crashingPage, storage, databaseBytes);
			await crashingPage.evaluate(
				({ actionJson, boundary }) =>
					window.browserReplicaConformanceEvidence.crashCurrent(
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
				throw new Error('crashed browser replica is closed');
			return observeOn(page, observation);
		},
		async closeCrashed(crashedId: number) {
			const page = crashedPages.get(crashedId);
			if (page === undefined) return;
			crashedPages.delete(crashedId);
			try {
				await page.evaluate(() =>
					window.browserReplicaConformanceEvidence.closeCurrent(true),
				);
			} finally {
				await page.close();
			}
		},
		reopen() {
			return requirePage(readPage).evaluate(() =>
				window.browserReplicaConformanceEvidence.reopen(),
			);
		},
		async dispose() {
			for (const crashedId of [...crashedPages.keys()]) {
				await this.closeCrashed(crashedId);
			}
			return requirePage(readPage).evaluate(() =>
				window.browserReplicaConformanceEvidence.dispose(),
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
		commit: () => driver.commit(action),
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
			if (witness === undefined)
				throw new Error('browser seal analysis returned no witness');
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
	createBinding(
		'production browser replica store (Chromium)',
		() => chromiumPage,
	),
);
runReplicaConformanceCases(
	createBinding('production browser replica store (WebKit)', () => webkitPage),
);

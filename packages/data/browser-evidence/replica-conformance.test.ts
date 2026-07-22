/**
 * Production Browser Replica Conformance Tests
 *
 * Binds the maintained replica transition cases to the browser candidate's
 * real ownership, session, RPC, reopen, and cleanup path in Chromium and
 * WebKit. A synchronized direct-store shadow is retained only for test-side
 * statement-boundary analysis and crash injection, which are deliberately
 * absent from the production protocol.
 *
 * Key behaviors:
 * - Ordinary semantic reads and commits cross the production candidate RPC
 * - The production owner and test-only crash shadow remain semantically equal
 * - Every shared crash boundary recovers the pre-transition logical state
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
import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
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
	BrowserReplicaCandidateStart,
	BrowserReplicaCandidateStatus,
} from '../src/store/replica/browser-candidate-protocol.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from '../src/store/replica/browser-owner-protocol.js';
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

	async function openProduction(
		page: Page,
		fixture: { replicaId: string; authorityLifetime?: string },
	): Promise<void> {
		const storageId = crypto.randomUUID();
		const options = {
			limits: makeLimits(),
			initialize: fixture,
			coordinationId: `epicenter-replica-conformance-${storageId}`,
			storage: {
				databaseFilename: '/replica.sqlite3',
				poolDirectory: `.epicenter-replica-conformance-production-${storageId}`,
				poolName: `epicenter-replica-conformance-production-${storageId}`,
			},
		} satisfies Omit<BrowserReplicaCandidateStart, 'type'>;
		const status = await page.evaluate(
			(optionsJson) =>
				window.browserReplicaCandidateEvidence
					.open(
						JSON.parse(optionsJson) as Omit<
							BrowserReplicaCandidateStart,
							'type'
						>,
					)
					.then(() => window.browserReplicaCandidateEvidence.status()),
			JSON.stringify(options),
		);
		if (status.role !== 'owner' || status.ownerSession === null) {
			throw new Error(
				'browser conformance candidate did not own a live session',
			);
		}
	}

	async function productionRequest(
		page: Page,
		operation: BrowserReplicaStoreOperation,
	): Promise<BrowserReplicaOwnerResult> {
		return page.evaluate(
			(operationJson) =>
				window.browserReplicaCandidateEvidence.request(
					JSON.parse(operationJson) as BrowserReplicaStoreOperation,
				),
			JSON.stringify(operation),
		);
	}

	async function productionStatus(
		page: Page,
	): Promise<BrowserReplicaCandidateStatus> {
		return page.evaluate(() => window.browserReplicaCandidateEvidence.status());
	}

	async function productionObservation(
		page: Page,
		observation: Exclude<BrowserReplicaObservation, { kind: 'snapshot' }>,
	): Promise<BrowserReplicaOwnerResult> {
		switch (observation.kind) {
			case 'record':
				return productionRequest(page, observation);
			case 'sync':
			case 'sealed-request':
			case 'reconstruct-sealed-request':
				return productionRequest(page, observation);
		}
	}

	async function assertShadowMatchesProduction(
		page: Page,
		action: BrowserReplicaAction,
	): Promise<void> {
		const observations: Exclude<
			BrowserReplicaObservation,
			{ kind: 'snapshot' }
		>[] = [{ kind: 'sync' }, { kind: 'sealed-request' }];
		switch (action.kind) {
			case 'local-write':
				observations.push({ kind: 'record', address: action.intent.address });
				break;
			case 'install-facts':
			case 'settle':
				for (const fact of action.kind === 'install-facts'
					? action.page.response.facts
					: action.response.facts) {
					observations.push({ kind: 'record', address: fact.address });
				}
				break;
			case 'seal':
			case 'erase':
				break;
		}
		for (const observation of observations) {
			const [production, shadow] = await Promise.all([
				productionObservation(page, observation),
				observeOn(page, observation),
			]);
			if (JSON.stringify(production) !== JSON.stringify(shadow)) {
				throw new Error(
					`production browser owner and crash shadow diverged after ${action.kind}`,
				);
			}
		}
	}

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
		async open(fixture: { replicaId: string; authorityLifetime?: string }) {
			const page = requirePage(readPage);
			await openProduction(page, fixture);
			try {
				await page.evaluate(
					(fixture) => window.browserReplicaConformanceEvidence.open(fixture),
					fixture,
				);
			} catch (cause) {
				await page.evaluate(() =>
					window.browserReplicaCandidateEvidence.close(),
				);
				throw cause;
			}
		},
		observe(observation: BrowserReplicaObservation) {
			if (observation.kind === 'snapshot') {
				return observeOn(requirePage(readPage), observation);
			}
			return productionObservation(requirePage(readPage), observation);
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
		async commit(action: BrowserReplicaAction) {
			const page = requirePage(readPage);
			let productionResult: BrowserReplicaOwnerResult;
			try {
				productionResult = await productionRequest(page, action);
			} catch (productionCause) {
				let didShadowRefuse = false;
				try {
					await page.evaluate(
						(actionJson) =>
							window.browserReplicaConformanceEvidence.commit(
								JSON.parse(actionJson) as BrowserReplicaAction,
							),
						JSON.stringify(action),
					);
				} catch {
					didShadowRefuse = true;
				}
				if (didShadowRefuse) {
					await assertShadowMatchesProduction(page, action);
					throw productionCause;
				}
				throw new Error(
					'production browser owner refused a transition accepted by the crash shadow',
					{ cause: productionCause },
				);
			}
			const shadowResult = await page.evaluate(
				(actionJson) =>
					window.browserReplicaConformanceEvidence.commit(
						JSON.parse(actionJson) as BrowserReplicaAction,
					),
				JSON.stringify(action),
			);
			if (action.kind === 'seal') {
				if (JSON.stringify(productionResult) !== JSON.stringify(shadowResult)) {
					throw new Error(
						'production browser owner and crash shadow produced different seal witnesses',
					);
				}
			}
			await assertShadowMatchesProduction(page, action);
			return productionResult;
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
		async reopen() {
			const page = requirePage(readPage);
			await productionRequest(page, { kind: 'reopen' });
			await page.evaluate(() =>
				window.browserReplicaConformanceEvidence.reopen(),
			);
			const status = await productionStatus(page);
			if (status.role !== 'owner' || status.ownerSession === null) {
				throw new Error('browser conformance candidate lost its owner session');
			}
		},
		async dispose() {
			for (const crashedId of [...crashedPages.keys()]) {
				await this.closeCrashed(crashedId);
			}
			const page = requirePage(readPage);
			await Promise.all([
				page.evaluate(() => window.browserReplicaCandidateEvidence.close()),
				page.evaluate(() => window.browserReplicaConformanceEvidence.dispose()),
			]);
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
					'production browser owner did not commit the analyzed seal witness',
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

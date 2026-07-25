/**
 * Production Browser Replica Conformance Tests
 *
 * Binds the maintained replica transition cases to the one browser owner's
 * real lock, RPC, reopen, and cleanup path in Chromium and WebKit. A synchronized direct-store shadow is retained only for test-side
 * statement-boundary analysis and crash injection, which are deliberately
 * absent from the production protocol.
 *
 * Key behaviors:
 * - Scalar, document, and blob operations cross the production owner RPC
 * - Document transitions stay equal to a crash-injectable OPFS shadow
 * - Blob watermarks and raw files survive reopen and reap on tombstone
 * - Owed scans use the production partial covering indexes in both engines
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
import {
	type BlobConformanceBinding,
	type BlobConformanceReplica,
	runBlobConformanceCases,
} from '../src/store/conformance/blob-cases.test-support.js';
import {
	type DocumentAction,
	type DocumentActionResult,
	type DocumentConformanceBinding,
	type DocumentConformanceReplica,
	runDocumentConformanceCases,
} from '../src/store/conformance/document-cases.test-support.js';
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
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from '../src/store/replica/browser-owner-protocol.js';
import type {
	BlobInspection,
	DocumentInspection,
} from '../src/store/replica/index.js';
import type {
	BrowserOwedQueryPlans,
	BrowserReplicaAction,
	BrowserReplicaAnalysis,
	BrowserReplicaObservation,
	BrowserReplicaStorageIdentity,
	BrowserReplicaTestResult,
} from './replica-conformance-contract.js';

const evidenceDir = import.meta.dirname;
// Crash-heavy WebKit cases late in the file legitimately exceed 30 seconds:
// every injected crash boots two fresh evidence pages over accumulated OPFS
// pools. The budget is per test; semantic waits keep their own timing.
setDefaultTimeout(120_000);
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
	// Late-suite WebKit reopens can take tens of seconds to boot a page under
	// accumulated OPFS and worker churn. The budget covers page boot only;
	// every semantic assertion keeps its own timing.
	page.setDefaultTimeout(60_000);
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
		await page.evaluate(
			([id, fixtureJson]) =>
				window.browserReplicaOwnerEvidence.open(
					id,
					JSON.parse(fixtureJson) as {
						replicaId: string;
						authorityLifetime?: string;
					},
				),
			[storageId, JSON.stringify(fixture)] as [string, string],
		);
	}

	async function productionRequest(
		page: Page,
		operation: BrowserReplicaStoreOperation,
	): Promise<BrowserReplicaOwnerResult> {
		return page.evaluate(
			(operation: unknown) =>
				window.browserReplicaOwnerEvidence.request(
					operation as BrowserReplicaStoreOperation,
				),
			operation as never,
		) as Promise<BrowserReplicaOwnerResult>;
	}

	function productionAction(
		action: BrowserReplicaAction,
	): BrowserReplicaStoreOperation {
		switch (action.kind) {
			case 'append-local':
				return {
					kind: 'append-local-document',
					address: action.address,
					update: action.update,
				};
			case 'install-accepted':
				return {
					kind: 'install-accepted-document',
					address: action.address,
					update: action.update,
				};
			case 'publication':
				return {
					kind: 'document-publication',
					address: action.address,
				};
			case 'settle-publication':
				return {
					kind: 'settle-document-publication',
					address: action.address,
					proof: action.proof,
					captured: action.captured,
				};
			case 'local-write':
			case 'seal':
			case 'settle':
			case 'install-facts':
			case 'erase':
				return action;
		}
	}

	async function productionObservation(
		page: Page,
		observation: Exclude<BrowserReplicaObservation, { kind: 'snapshot' }>,
	): Promise<BrowserReplicaOwnerResult> {
		switch (observation.kind) {
			case 'record':
				return productionRequest(page, observation);
			case 'inspect-document':
			case 'export-document':
			case 'owed-documents':
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
			case 'append-local':
			case 'install-accepted':
			case 'publication':
			case 'settle-publication':
				observations.push({
					kind: 'inspect-document',
					address: action.address,
				});
				observations.push({
					kind: 'export-document',
					address: action.address,
				});
				break;
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
			(observation) =>
				window.browserReplicaConformanceEvidence.observe(observation),
			observation,
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
				await page.evaluate(() => window.browserReplicaOwnerEvidence.dispose());
				throw cause;
			}
		},
		observe(observation: BrowserReplicaObservation) {
			if (
				observation.kind === 'snapshot' ||
				observation.kind === 'owed-query-plans'
			) {
				return observeOn(requirePage(readPage), observation);
			}
			return productionObservation(requirePage(readPage), observation);
		},
		requestProduction(operation: BrowserReplicaStoreOperation) {
			return productionRequest(requirePage(readPage), operation);
		},
		captureBlob(address: RecordAddress, text: string) {
			return requirePage(readPage).evaluate(
				async ({ address, text }) => {
					const outcome = await window.browserReplicaOwnerEvidence.request({
						kind: 'capture-blob',
						address,
						bytes: new Blob([text]),
					});
					if (
						outcome === null ||
						typeof outcome !== 'object' ||
						!('kind' in outcome) ||
						outcome.kind !== 'captured'
					) {
						throw new Error('browser blob capture did not capture bytes');
					}
					return outcome.digest;
				},
				{ address, text },
			) as Promise<string>;
		},
		blobPublication(address: RecordAddress) {
			return requirePage(readPage).evaluate(async (address) => {
				const publication = await window.browserReplicaOwnerEvidence.request({
					kind: 'blob-publication',
					address,
				});
				if (
					publication === null ||
					typeof publication !== 'object' ||
					!('kind' in publication)
				) {
					throw new Error('browser blob publication has an invalid shape');
				}
				if (publication.kind !== 'ready') return null;
				if (
					!('publication' in publication) ||
					typeof publication.publication !== 'object' ||
					publication.publication === null ||
					!('request' in publication.publication) ||
					!('bytes' in publication.publication) ||
					!(publication.publication.bytes instanceof Blob)
				) {
					throw new Error('browser blob publication has an invalid shape');
				}
				return {
					digest: publication.publication.request.digest,
					text: await publication.publication.bytes.text(),
				};
			}, address);
		},
		contentFileCount() {
			return requirePage(readPage).evaluate(async () => {
				type IterableDirectory = FileSystemDirectoryHandle & {
					values(): AsyncIterableIterator<FileSystemHandle>;
				};
				const root = await navigator.storage.getDirectory();
				const blobs = await root.getDirectoryHandle('blobs');
				const content = (await blobs.getDirectoryHandle(
					'content',
				)) as IterableDirectory;
				let count = 0;
				for await (const owner of content.values()) {
					if (owner.kind !== 'directory') continue;
					const directory = (await content.getDirectoryHandle(
						owner.name,
					)) as IterableDirectory;
					for await (const entry of directory.values()) {
						if (entry.kind === 'file') count += 1;
					}
				}
				return count;
			});
		},
		analyze(action: BrowserReplicaAction) {
			return requirePage(readPage).evaluate(
				(action: unknown) =>
					window.browserReplicaConformanceEvidence.analyze(
						action as BrowserReplicaAction,
					),
				action as never,
			) as Promise<BrowserReplicaAnalysis>;
		},
		async commit(action: BrowserReplicaAction) {
			const page = requirePage(readPage);
			let productionResult: BrowserReplicaOwnerResult;
			try {
				productionResult = await productionRequest(
					page,
					productionAction(action),
				);
			} catch (productionCause) {
				let didShadowRefuse = false;
				try {
					await page.evaluate(
						(action: unknown) =>
							window.browserReplicaConformanceEvidence.commit(
								action as BrowserReplicaAction,
							),
						action as never,
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
			const shadowResult = (await page.evaluate(
				(action: unknown) =>
					window.browserReplicaConformanceEvidence.commit(
						action as BrowserReplicaAction,
					),
				action as never,
			)) as BrowserReplicaTestResult;
			const actionResult =
				action.kind === 'seal' &&
				productionResult !== null &&
				typeof productionResult === 'object' &&
				'kind' in productionResult &&
				productionResult.kind === 'sealed'
					? productionResult.request
					: productionResult;
			if (action.kind === 'seal') {
				if (JSON.stringify(actionResult) !== JSON.stringify(shadowResult)) {
					throw new Error(
						'production browser owner and crash shadow produced different seal witnesses',
					);
				}
			}
			if (
				action.kind === 'publication' &&
				JSON.stringify(productionResult) !== JSON.stringify(shadowResult)
			) {
				throw new Error(
					'production browser owner and crash shadow produced different document publications',
				);
			}
			await assertShadowMatchesProduction(page, action);
			return actionResult;
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
				({ action, boundary }: { action: unknown; boundary: number }) =>
					window.browserReplicaConformanceEvidence.crashCurrent(
						action as BrowserReplicaAction,
						boundary,
					),
				{ action, boundary } as never,
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
		},
		async dispose() {
			for (const crashedId of [...crashedPages.keys()]) {
				await this.closeCrashed(crashedId);
			}
			const page = requirePage(readPage);
			await Promise.all([
				page.evaluate(() => window.browserReplicaOwnerEvidence.dispose()),
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

function documentObservations(
	driver: Driver,
	crashedId?: number,
): Pick<
	DocumentConformanceReplica,
	'inspectDocument' | 'exportDocument' | 'owedDocuments' | 'snapshot'
> {
	function observe(observation: BrowserReplicaObservation) {
		return crashedId === undefined
			? driver.observe(observation)
			: driver.observeCrashed(crashedId, observation);
	}
	return {
		inspectDocument: (address) =>
			observe({
				kind: 'inspect-document',
				address,
			}) as Promise<DocumentInspection | null>,
		exportDocument: (address) =>
			observe({ kind: 'export-document', address }) as Promise<
				Uint8Array | undefined
			>,
		owedDocuments: (limit) =>
			(crashedId === undefined
				? driver.requestProduction({
						kind: 'owed-documents',
						after: null,
						limit,
					})
				: observe({ kind: 'owed-documents', after: null, limit })) as Promise<
				RecordAddress[]
			>,
		snapshot: () => observe({ kind: 'snapshot' }) as Promise<string>,
	};
}

function documentConformanceReplica(
	driver: Driver,
): DocumentConformanceReplica {
	return {
		...documentObservations(driver),
		async prepare(action: DocumentAction) {
			const analysis = await driver.analyze(action);
			return {
				boundaries: analysis.boundaries,
				async crash(boundary) {
					const crashedId = await driver.crash(action, boundary);
					return {
						...documentObservations(driver, crashedId),
						close: () => driver.closeCrashed(crashedId),
					};
				},
				commit: () => driver.commit(action) as Promise<DocumentActionResult>,
			};
		},
		async reopen() {
			await driver.reopen();
			return documentConformanceReplica(driver);
		},
		dispose: () => driver.dispose(),
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
			if (witness === undefined || !('bytes' in witness))
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

function createDocumentBinding(
	name: string,
	readPage: () => Page | undefined,
): DocumentConformanceBinding {
	const driver = createDriver(readPage);
	return {
		name,
		async create() {
			await driver.open({
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'lifetime-one',
			});
			await driver.commit({
				kind: 'local-write',
				intent: {
					address: {
						namespace: 'so.epicenter.notes',
						collection: 'records',
						recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					},
					op: 'replace',
					value: {},
				},
			});
			return documentConformanceReplica(driver);
		},
	};
}

function createBlobBinding(
	name: string,
	readPage: () => Page | undefined,
): BlobConformanceBinding {
	const driver = createDriver(readPage);
	function bind(): BlobConformanceReplica {
		return {
			capture: (address, text) => driver.captureBlob(address, text),
			inspectBlob: (address) =>
				driver.requestProduction({
					kind: 'inspect-blob',
					address,
				}) as Promise<BlobInspection>,
			publication: (address) => driver.blobPublication(address),
			settle: (address, acceptance) =>
				driver.requestProduction({
					kind: 'settle-blob-publication',
					address,
					acceptance,
				}) as Promise<void>,
			owedBlobs: (limit) =>
				driver.requestProduction({
					kind: 'owed-blobs',
					after: null,
					limit,
				}) as Promise<RecordAddress[]>,
			appendDocument: (address, update) =>
				driver.requestProduction({
					kind: 'append-local-document',
					address,
					update,
				}) as Promise<void>,
			inspectDocument: (address) =>
				driver.requestProduction({
					kind: 'inspect-document',
					address,
				}) as Promise<DocumentInspection | null>,
			async tombstone(address) {
				await driver.requestProduction({
					kind: 'local-write',
					intent: { address, op: 'tombstone' },
				});
			},
			sweepDebris: () =>
				driver.requestProduction({
					kind: 'sweep-blob-debris',
				}) as Promise<void>,
			contentFileCount: () => driver.contentFileCount(),
			async reopen() {
				await driver.reopen();
				return bind();
			},
			dispose: () => driver.dispose(),
		};
	}
	return {
		name,
		async create() {
			await driver.open({
				replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
				authorityLifetime: 'lifetime-one',
			});
			await driver.commit({
				kind: 'local-write',
				intent: {
					address: {
						namespace: 'so.epicenter.notes',
						collection: 'records',
						recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					},
					op: 'replace',
					value: {},
				},
			});
			return bind();
		},
	};
}

runReplicaConformanceCases(
	createBinding(
		'production browser replica store (Chromium)',
		() => chromiumPage,
	),
);

for (const [engineName, readPage] of [
	['Chromium', () => chromiumPage],
	['WebKit', () => webkitPage],
] as const) {
	test(`${engineName} OPFS owed scans use the covering watermark indexes`, async () => {
		const driver = createDriver(readPage);
		await driver.open({
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		});
		try {
			const plans = (await driver.observe({
				kind: 'owed-query-plans',
			})) as BrowserOwedQueryPlans;
			expect(plans.document.join('\n')).toContain('records_document_owed');
			expect(plans.blob.join('\n')).toContain('records_blob_owed');
			console.log(
				`${engineName} document owed plan: ${plans.document.join(' | ')}`,
			);
			console.log(`${engineName} blob owed plan: ${plans.blob.join(' | ')}`);
		} finally {
			await driver.dispose();
		}
	});
}
runDocumentConformanceCases(
	createDocumentBinding(
		'production browser OPFS replica owner (Chromium)',
		() => chromiumPage,
	),
);
runBlobConformanceCases(
	createBlobBinding(
		'production browser OPFS replica owner (Chromium)',
		() => chromiumPage,
	),
);
runBlobConformanceCases(
	createBlobBinding(
		'production browser OPFS replica owner (WebKit)',
		() => webkitPage,
	),
);
runDocumentConformanceCases(
	createDocumentBinding(
		'production browser OPFS replica owner (WebKit)',
		() => webkitPage,
	),
);
runReplicaConformanceCases(
	createBinding('production browser replica store (WebKit)', () => webkitPage),
);

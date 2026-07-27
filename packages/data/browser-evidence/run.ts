import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
	type Browser,
	type BrowserType,
	chromium,
	type Page,
	webkit,
} from 'playwright';

import type { EvidenceFeatures, EvidenceSnapshot } from './contract.js';
import { createEvidenceEngineLifecycle } from './engine-lifecycle.js';
import {
	assertBrowserEngineEvidence,
	type BrowserEngineEvidence,
	classifyEvidence,
	type EvidenceCell,
	type EvidenceCellId,
	type EvidenceEngine,
	evidenceInjectionFor,
} from './evidence.js';

const evidenceDir = import.meta.dirname;
const repoRoot = resolve(evidenceDir, '../../..');
const distDir = resolve(evidenceDir, 'dist');
const require = createRequire(import.meta.url);
const playwrightVersion = (
	JSON.parse(
		readFileSync(require.resolve('playwright/package.json'), 'utf8'),
	) as { version: string }
).version;
const cellTimeoutMs = 20_000;

const engineTypes: Record<EvidenceEngine, BrowserType<Browser>> = {
	chromium,
	webkit,
};

class UnsupportedEvidence extends Error {
	override readonly name = 'UnsupportedEvidence';
}

class EvidenceDeadlineError extends Error {
	override readonly name = 'EvidenceDeadlineError';
}

class FatalEvidenceRunError extends Error {
	override readonly name = 'FatalEvidenceRunError';
}

type CellResult = {
	parameters?: EvidenceCell['parameters'];
	proofs?: EvidenceCell['proofs'];
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new EvidenceDeadlineError(`${label} exceeded ${cellTimeoutMs}ms`),
						),
					cellTimeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitFor<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
	label: string,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let latest = await read();
	while (!accept(latest)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(25);
		latest = await read();
	}
	return latest;
}

function snapshotProofs(snapshot: EvidenceSnapshot): EvidenceCell['proofs'] {
	return {
		rowCount: snapshot.rowCount,
		semanticSha256: snapshot.semanticSha256,
		...(snapshot.storageUsageBytes === undefined
			? {}
			: { storageUsageBytes: snapshot.storageUsageBytes }),
		...(snapshot.storageQuotaBytes === undefined
			? {}
			: { storageQuotaBytes: snapshot.storageQuotaBytes }),
	};
}

function serializeError(cause: unknown): NonNullable<EvidenceCell['error']> {
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			...(cause.stack === undefined ? {} : { stack: cause.stack }),
		};
	}
	return { name: 'Error', message: String(cause) };
}

async function sha256File(path: string): Promise<string> {
	return createHash('sha256')
		.update(new Uint8Array(await Bun.file(path).arrayBuffer()))
		.digest('hex');
}

function listFiles(path: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === 'artifacts' || entry.name === 'dist') continue;
		const child = join(path, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(child));
		else if (entry.isFile()) files.push(child);
	}
	return files;
}

function hashHarness(): string {
	const hash = createHash('sha256');
	for (const path of listFiles(evidenceDir).sort()) {
		hash.update(relative(evidenceDir, path));
		hash.update('\0');
		hash.update(readFileSync(path));
		hash.update('\0');
	}
	return hash.digest('hex');
}

function git(args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], {
		cwd: repoRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (!result.success) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trimEnd();
}

function parseArguments(): {
	engines: EvidenceEngine[];
	outputDir: string;
} {
	const engines: EvidenceEngine[] = [];
	let outputDir = resolve(evidenceDir, 'artifacts');
	for (let index = 2; index < Bun.argv.length; index += 1) {
		const argument = Bun.argv[index];
		if (argument === '--engine') {
			const value = Bun.argv[index + 1];
			if (value !== 'chromium' && value !== 'webkit') {
				throw new Error(`Unsupported browser engine '${String(value)}'`);
			}
			engines.push(value);
			index += 1;
			continue;
		}
		if (argument === '--output') {
			const value = Bun.argv[index + 1];
			if (value === undefined) throw new Error('--output requires a path');
			outputDir = resolve(process.cwd(), value);
			index += 1;
			continue;
		}
		if (argument === '--profile') {
			const value = Bun.argv[index + 1];
			if (value !== 'smoke') {
				throw new Error(
					'This foundation intentionally supports only --profile smoke',
				);
			}
			index += 1;
			continue;
		}
		throw new Error(`Unknown browser evidence argument '${String(argument)}'`);
	}
	return {
		engines:
			engines.length === 0 ? ['chromium', 'webkit'] : [...new Set(engines)],
		outputDir,
	};
}

async function buildFixture(): Promise<void> {
	const build = Bun.spawnSync(
		['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
		{
			cwd: evidenceDir,
			stdout: 'inherit',
			stderr: 'inherit',
		},
	);
	if (!build.success) throw new Error('Browser evidence fixture build failed');
}

function startFixtureServer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
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
			return new Response(file);
		},
	});
}

async function runEngine({
	engineName,
	origin,
	runId,
	tempDir,
}: {
	engineName: EvidenceEngine;
	origin: string;
	runId: string;
	tempDir: string;
}): Promise<BrowserEngineEvidence> {
	const engineStarted = Date.now();
	const startedAt = new Date(engineStarted).toISOString();
	const profileDir = join(tempDir, `${engineName}-profile`);
	mkdirSync(profileDir, { recursive: true });
	const browserType = engineTypes[engineName];
	let context = await browserType.launchPersistentContext(profileDir, {
		headless: true,
	});
	let browserVersion = context.browser()?.version() ?? 'unknown';
	let userAgent = '';
	const lifecycle = createEvidenceEngineLifecycle(
		() => context.close(),
		async () => {
			const browser = context.browser();
			if (browser === null) await context.close();
			else await browser.close({ reason: 'Browser evidence forced cleanup' });
		},
	);
	const pageErrors: string[] = [];
	const cells: EvidenceCell[] = [];
	let features: EvidenceFeatures = {
		secureContext: false,
		dedicatedWorker: false,
		opfs: false,
		webLocks: false,
		syncAccessHandle: false,
	};

	try {
		async function openPage(): Promise<Page> {
			const page = await context.newPage();
			page.setDefaultTimeout(15_000);
			page.on('pageerror', (error) =>
				pageErrors.push(error.stack ?? error.message),
			);
			await page.goto(origin);
			await page.waitForFunction(() => window.browserEvidence !== undefined);
			if (userAgent === '')
				userAgent = await page.evaluate(() => navigator.userAgent);
			return page;
		}

		async function runCell(
			id: EvidenceCellId,
			action: () => Promise<CellResult>,
		): Promise<void> {
			const cellStarted = Date.now();
			const cellStartedAt = new Date(cellStarted).toISOString();
			const errorsBefore = pageErrors.length;
			try {
				const stoppedReason = lifecycle.stoppedReason();
				if (stoppedReason !== undefined) {
					throw new UnsupportedEvidence(
						`A previous cell stopped this browser context: ${stoppedReason}`,
					);
				}
				const result = await withDeadline(action(), id);
				const newErrors = pageErrors.slice(errorsBefore);
				if (newErrors.length > 0) {
					throw new Error(`Browser page errors: ${newErrors.join('; ')}`);
				}
				const ended = Date.now();
				cells.push({
					id,
					injection: evidenceInjectionFor(id),
					outcome: 'passed',
					startedAt: cellStartedAt,
					endedAt: new Date(ended).toISOString(),
					durationMs: ended - cellStarted,
					parameters: result.parameters ?? [],
					proofs: result.proofs ?? {},
				});
			} catch (cause) {
				const ended = Date.now();
				const unsupported =
					cause instanceof UnsupportedEvidence ||
					(id === 'feature-admission' &&
						cause instanceof EvidenceDeadlineError);
				const outcome = lifecycle.recordCellFailure({
					reason:
						cause instanceof Error ? cause.message : `Cell '${id}' failed`,
					unsupported,
					deadline: cause instanceof EvidenceDeadlineError,
				});
				if (
					id === 'persistent-profile-relaunch' &&
					cause instanceof EvidenceDeadlineError
				) {
					throw new FatalEvidenceRunError(
						'Persistent-profile relaunch timed out with an uncancelled browser acquisition; aborting the run before profile cleanup',
						{ cause },
					);
				}
				cells.push({
					id,
					injection: evidenceInjectionFor(id),
					outcome,
					startedAt: cellStartedAt,
					endedAt: new Date(ended).toISOString(),
					durationMs: ended - cellStarted,
					parameters: [],
					proofs: {},
					...(unsupported
						? { reason: cause.message }
						: { error: serializeError(cause) }),
				});
			}
		}

		await runCell('feature-admission', async () => {
			const page = await openPage();
			try {
				features = await page.evaluate(() => window.browserEvidence.features());
				const missing = Object.entries(features)
					.filter(
						([name, value]) =>
							!name.endsWith('Bytes') && typeof value === 'boolean' && !value,
					)
					.map(([name]) => name);
				if (missing.length > 0) {
					throw new UnsupportedEvidence(
						`Required browser features are unavailable: ${missing.join(', ')}`,
					);
				}
				try {
					await page.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-admission`,
					);
				} catch (cause) {
					if (
						cause instanceof Error &&
						cause.message.includes('Missing required OPFS APIs')
					) {
						throw new UnsupportedEvidence(
							'The real DedicatedWorker SQLite SAH-pool path reports missing OPFS APIs',
						);
					}
					throw cause;
				}
				const row = await page.evaluate(
					({ title, writer }) => window.browserEvidence.create(title, writer),
					{ title: `${runId}-admission`, writer: 'admission' },
				);
				const snapshot = await page.evaluate(() =>
					window.browserEvidence.snapshot(),
				);
				assert(
					snapshot.rows.some(({ id }) => id === row.id),
					'Admission write was absent',
				);
				await page.evaluate(() => window.browserEvidence.dispose());
				return { proofs: snapshotProofs(snapshot) };
			} finally {
				await page.close();
			}
		});

		const featureCell = cells.find(({ id }) => id === 'feature-admission');
		if (featureCell?.outcome !== 'passed') {
			for (const id of [
				'crud-durability-reload',
				'second-owner-refusal',
				'hung-sync-continuity',
				'worker-termination-lock-handoff',
				'persistent-profile-relaunch',
			] as const) {
				await runCell(id, () => {
					throw new UnsupportedEvidence('Feature admission did not pass');
				});
			}
		} else {
			await runCell('crud-durability-reload', async () => {
				const page = await openPage();
				try {
					await page.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-crud`,
					);
					const row = await page.evaluate(
						({ title, writer }) => window.browserEvidence.create(title, writer),
						{ title: `${runId}-durable`, writer: 'crud' },
					);
					const documentSha256 = await page.evaluate(
						({ rowId, content }) =>
							window.browserEvidence.setDocument(rowId, content),
						{ rowId: row.id, content: `${runId}-document` },
					);
					const before = await page.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					await page.evaluate(() => window.browserEvidence.dispose());
					await page.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-crud`,
					);
					const after = await page.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					const content = await page.evaluate(
						(rowId) => window.browserEvidence.readDocument(rowId),
						row.id,
					);
					assert(
						before.semanticSha256 === after.semanticSha256,
						'Scalar state changed after reopen',
					);
					assert(
						content === `${runId}-document`,
						'Document state changed after reopen',
					);
					await page.evaluate(() => window.browserEvidence.dispose());
					return {
						parameters: [
							{ name: 'beforeSemanticSha256', value: before.semanticSha256 },
							{ name: 'reopenedSemanticSha256', value: after.semanticSha256 },
						],
						proofs: { ...snapshotProofs(after), documentSha256 },
					};
				} finally {
					await page.close();
				}
			});

			await runCell('second-owner-refusal', async () => {
				const first = await openPage();
				const second = await openPage();
				try {
					await first.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-first-owner`,
					);
					await first.evaluate(
						({ title, writer }) => window.browserEvidence.create(title, writer),
						{ title: `${runId}-first-owner`, writer: 'first-owner' },
					);
					const firstSnapshot = await first.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					const refusalMessage = await second.evaluate(async (name) => {
						try {
							await window.browserEvidence.open(name);
							await window.browserEvidence.snapshot();
							return undefined;
						} catch (cause) {
							return cause instanceof Error ? cause.message : String(cause);
						}
					}, `${runId}-${engineName}-refused-owner`);
					const expected =
						'Browser Epicenter is already open in another tab for this origin';
					assert(
						refusalMessage === expected,
						`Second same-origin owner refusal differed: ${String(refusalMessage)}`,
					);
					await Promise.all([
						first.evaluate(() => window.browserEvidence.dispose()),
						second.evaluate(() => window.browserEvidence.dispose()),
					]);
					return {
						parameters: [{ name: 'refusalMessage', value: refusalMessage }],
						proofs: snapshotProofs(firstSnapshot),
					};
				} finally {
					await Promise.allSettled([first.close(), second.close()]);
				}
			});

			await runCell('hung-sync-continuity', async () => {
				const page = await openPage();
				try {
					await page.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-hung`,
					);
					await page.evaluate(() => window.browserEvidence.startHungSync());
					await waitFor(
						() => page.evaluate(() => window.browserEvidence.hungSyncStatus()),
						(status) => status.started,
						'hung sync transport',
					);
					const sameTabRow = await page.evaluate(
						({ title, writer }) => window.browserEvidence.create(title, writer),
						{ title: `${runId}-hung-same-owner`, writer: 'hung' },
					);
					const snapshot = await page.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					const hungStatus = await page.evaluate(() =>
						window.browserEvidence.hungSyncStatus(),
					);
					assert(
						hungStatus.started && hungStatus.hungOutcome === undefined,
						'Hung sync transport settled before the continuity witness',
					);
					const sameTabRowOccurrences = snapshot.rows.filter(
						({ id }) => id === sameTabRow.id,
					).length;
					assert(
						sameTabRowOccurrences === 1,
						'Hung sync continuity snapshot did not contain the same-owner write exactly once',
					);
					await page.evaluate(() => window.browserEvidence.dispose());
					return {
						parameters: [
							{ name: 'syncStarted', value: true },
							{ name: 'syncPending', value: true },
							{ name: 'sameTabRowId', value: sameTabRow.id },
							{
								name: 'sameTabRowOccurrences',
								value: sameTabRowOccurrences,
							},
							{
								name: 'claim',
								value: 'same-owner-local-rpc-continuity-only',
							},
						],
						proofs: snapshotProofs(snapshot),
					};
				} finally {
					await page.close();
				}
			});

			await runCell('worker-termination-lock-handoff', async () => {
				const first = await openPage();
				try {
					await first.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-terminated`,
					);
					await first.evaluate(
						({ title, writer }) => window.browserEvidence.create(title, writer),
						{ title: `${runId}-before-worker-close`, writer: 'terminated' },
					);
					const before = await first.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					await first.evaluate(() => window.browserEvidence.terminateWorker());
					await first.close();

					const replacement = await openPage();
					try {
						await replacement.evaluate(
							(name) => window.browserEvidence.open(name),
							`${runId}-${engineName}-replacement`,
						);
						const reopened = await replacement.evaluate(() =>
							window.browserEvidence.snapshot(),
						);
						assert(
							before.semanticSha256 === reopened.semanticSha256,
							'Worker replacement did not preserve committed state',
						);
						await replacement.evaluate(
							({ title, writer }) =>
								window.browserEvidence.create(title, writer),
							{ title: `${runId}-after-worker-close`, writer: 'replacement' },
						);
						const continued = await replacement.evaluate(() =>
							window.browserEvidence.snapshot(),
						);
						assert(
							continued.rowCount === reopened.rowCount + 1,
							'Replacement worker did not accept a new write',
						);
						await replacement.evaluate(() => window.browserEvidence.dispose());
						return {
							parameters: [
								{ name: 'beforeRowCount', value: before.rowCount },
								{ name: 'reopenedRowCount', value: reopened.rowCount },
								{
									name: 'beforeSemanticSha256',
									value: before.semanticSha256,
								},
								{
									name: 'reopenedSemanticSha256',
									value: reopened.semanticSha256,
								},
							],
							proofs: snapshotProofs(continued),
						};
					} finally {
						await replacement.close();
					}
				} finally {
					await first.close().catch(() => undefined);
				}
			});

			await runCell('persistent-profile-relaunch', async () => {
				const beforePage = await openPage();
				await beforePage.evaluate(
					(name) => window.browserEvidence.open(name),
					`${runId}-${engineName}-before-relaunch`,
				);
				await beforePage.evaluate(
					({ title, writer }) => window.browserEvidence.create(title, writer),
					{ title: `${runId}-before-relaunch`, writer: 'relaunch' },
				);
				const before = await beforePage.evaluate(() =>
					window.browserEvidence.snapshot(),
				);
				await context.close();
				context = await browserType.launchPersistentContext(profileDir, {
					headless: true,
				});
				browserVersion = context.browser()?.version() ?? browserVersion;
				const afterPage = await openPage();
				try {
					await afterPage.evaluate(
						(name) => window.browserEvidence.open(name),
						`${runId}-${engineName}-after-relaunch`,
					);
					const reopened = await afterPage.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					assert(
						before.semanticSha256 === reopened.semanticSha256,
						'Persistent-profile relaunch changed committed state',
					);
					await afterPage.evaluate(
						({ title, writer }) => window.browserEvidence.create(title, writer),
						{ title: `${runId}-after-relaunch`, writer: 'relaunch' },
					);
					const continued = await afterPage.evaluate(() =>
						window.browserEvidence.snapshot(),
					);
					await afterPage.evaluate(() => window.browserEvidence.dispose());
					return {
						parameters: [
							{ name: 'beforeRowCount', value: before.rowCount },
							{ name: 'reopenedRowCount', value: reopened.rowCount },
							{ name: 'beforeSemanticSha256', value: before.semanticSha256 },
							{
								name: 'reopenedSemanticSha256',
								value: reopened.semanticSha256,
							},
						],
						proofs: snapshotProofs(continued),
					};
				} finally {
					await afterPage.close();
				}
			});
		}

		await runCell('synthetic-page-freeze', () => {
			throw new UnsupportedEvidence(
				engineName === 'chromium'
					? 'No reliable bounded CDP freeze proof is included in this foundation'
					: 'Playwright WebKit does not expose Chromium CDP lifecycle controls',
			);
		});
		await runCell('synthetic-quota-refusal', () => {
			throw new UnsupportedEvidence(
				engineName === 'chromium'
					? 'CDP quota override has not been proven to constrain the OPFS SAH-pool VFS'
					: 'Playwright WebKit does not expose Chromium CDP quota controls',
			);
		});

		const ended = Date.now();
		const dirtyPaths = git(['status', '--porcelain', '--untracked-files=all'])
			.split('\n')
			.filter(Boolean)
			.map((line) => line.slice(3));
		const evidence: BrowserEngineEvidence = {
			schemaVersion: 'epicenter-browser-engine-evidence/v2',
			kind: 'epicenter-browser-engine-evidence',
			scope: 'pre-physical-browser-engine',
			decisionEligible: false,
			semanticWitnessScope: 'within-run-only',
			runId: `${runId}-${engineName}`,
			startedAt,
			endedAt: new Date(ended).toISOString(),
			durationMs: ended - engineStarted,
			source: {
				commit: git(['rev-parse', 'HEAD']),
				clean: dirtyPaths.length === 0,
				dirtyPaths,
				lockfileSha256: await sha256File(resolve(repoRoot, 'bun.lock')),
				harnessSha256: hashHarness(),
			},
			runtime: {
				engine: engineName,
				playwrightVersion,
				browserVersion,
				userAgent,
				platform: process.platform,
				architecture: process.arch,
				headless: true,
				persistentProfile: true,
				origin,
			},
			features,
			cells,
			limitations: [
				'Semantic hashes are within-run reopen and convergence witnesses; generated row IDs prevent cross-run or cross-engine comparison.',
				'Playwright WebKit is not branded Safari and supplies no physical Safari evidence.',
				'Desktop browser engines do not qualify iOS Safari or Android Chrome storage capacity.',
				'Second-owner refusal proves fail-fast ownership exclusion, not concurrent same-origin tab access.',
				'Worker termination proves browser-engine lease release, not graceful shutdown of in-flight writes.',
				'Persistent WebKit origin evidence does not prove profile isolation.',
				'The fixture injects a statically bundled public dedicated-worker entry; it does not qualify the library default worker URL through every consuming bundler.',
			],
			overall: classifyEvidence(engineName, cells),
		};
		assertBrowserEngineEvidence(evidence);
		return evidence;
	} finally {
		await lifecycle.close();
	}
}

const { engines, outputDir } = parseArguments();
await buildFixture();
mkdirSync(outputDir, { recursive: true });
const server = startFixtureServer();
const origin = `http://${server.hostname}:${server.port}`;
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
const tempDir = mkdtempSync(join(tmpdir(), 'epicenter-browser-evidence-'));
let failed = false;
let fatalError: unknown;

try {
	for (const engineName of engines) {
		process.stdout.write(`browser evidence: ${engineName}\n`);
		const evidence = await runEngine({
			engineName,
			origin,
			runId,
			tempDir,
		});
		const artifactPath = resolve(
			outputDir,
			`${basename(runId)}-${engineName}.json`,
		);
		await Bun.write(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
		process.stdout.write(
			`browser evidence: ${engineName} ${evidence.overall} ${artifactPath}\n`,
		);
		if (evidence.overall !== 'provisional') failed = true;
	}
} catch (cause) {
	fatalError = cause;
	failed = true;
} finally {
	server.stop(true);
	if (fatalError === undefined) {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

if (fatalError !== undefined) {
	process.stderr.write(
		`browser evidence failed; retained temporary profiles at ${tempDir}: ${fatalError instanceof Error ? (fatalError.stack ?? fatalError.message) : String(fatalError)}\n`,
	);
}

process.exit(failed ? 1 : 0);

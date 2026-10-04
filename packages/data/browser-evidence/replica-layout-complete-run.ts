#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
	type Browser,
	type BrowserContext,
	type BrowserType,
	chromium,
	type Page,
	webkit,
} from 'playwright';

import {
	COMPLETE_FINGERPRINT_BOUNDARY,
	COMPLETE_PROFILES,
	COMPLETE_SEEDING_DISCLOSURES,
	type CompleteEngine,
	type CompleteEngineResult,
	type CompleteEvidenceReport,
	type CompleteProfile,
} from './replica-layout-complete-contract.js';

const evidenceDir = import.meta.dirname;
const packageDir = resolve(evidenceDir, '..');
const repoRoot = resolve(evidenceDir, '../../..');
const distDir = resolve(evidenceDir, 'dist/replica-layout-complete');
const reportDate = '2026-07-22';
const require = createRequire(import.meta.url);
const playwrightVersion = (
	JSON.parse(
		readFileSync(require.resolve('playwright/package.json'), 'utf8'),
	) as { version: string }
).version;

const browserTypes: Record<CompleteEngine, BrowserType<Browser>> = {
	chromium,
	webkit,
};

type Options = {
	profile: CompleteProfile;
	engines: CompleteEngine[];
	commit: string;
	outputDir: string;
};

function parseArguments(): Options {
	let profile: CompleteProfile | undefined;
	let engine: CompleteEngine | 'both' | undefined;
	let commit: string | undefined;
	let outputDir = resolve(repoRoot, 'docs/benchmarks/replica-layout');
	for (let index = 2; index < Bun.argv.length; index += 1) {
		const argument = Bun.argv[index];
		const value = Bun.argv[index + 1];
		if (value === undefined) throw new Error(`${argument} requires a value`);
		switch (argument) {
			case '--profile':
				if (value !== 'smoke' && value !== 'full') {
					throw new Error('--profile must be smoke or full');
				}
				profile = value;
				break;
			case '--engine':
				if (value !== 'chromium' && value !== 'webkit' && value !== 'both') {
					throw new Error('--engine must be chromium, webkit, or both');
				}
				engine = value;
				break;
			case '--commit':
				commit = value;
				break;
			case '--output-dir':
				outputDir = resolve(repoRoot, value);
				break;
			default:
				throw new Error(`Unknown argument ${String(argument)}`);
		}
		index += 1;
	}
	if (profile === undefined) throw new Error('--profile is required');
	if (engine === undefined) throw new Error('--engine is required');
	if (commit === undefined || commit.length === 0) {
		throw new Error('--commit is required');
	}
	return {
		profile,
		engines: engine === 'both' ? ['chromium', 'webkit'] : [engine],
		commit,
		outputDir,
	};
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceEvidence(): CompleteEvidenceReport['source'] {
	const files = {
		worker: resolve(evidenceDir, 'replica-layout-complete-worker.ts'),
		client: resolve(evidenceDir, 'replica-layout-complete-client.ts'),
		runner: resolve(evidenceDir, 'replica-layout-complete-run.ts'),
	};
	return {
		fingerprintBoundary: COMPLETE_FINGERPRINT_BOUNDARY,
		files: {
			worker: {
				path: relative(repoRoot, files.worker),
				sha256: sha256File(files.worker),
			},
			client: {
				path: relative(repoRoot, files.client),
				sha256: sha256File(files.client),
			},
			runner: {
				path: relative(repoRoot, files.runner),
				sha256: sha256File(files.runner),
			},
		},
	};
}

function buildFixture(): void {
	const result = Bun.spawnSync(
		[
			'bun',
			'x',
			'vite',
			'build',
			'--config',
			'browser-evidence/replica-layout-complete-vite.config.ts',
		],
		{ cwd: packageDir, stdout: 'inherit', stderr: 'inherit' },
	);
	if (!result.success) throw new Error('Browser COMPLETE fixture build failed');
}

function startFixtureServer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const pathname =
				url.pathname === '/'
					? '/replica-layout-complete-index.html'
					: url.pathname;
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
	engine,
	profile,
	origin,
	tempRoot,
}: {
	engine: CompleteEngine;
	profile: CompleteProfile;
	origin: string;
	tempRoot: string;
}): Promise<{
	result: CompleteEngineResult;
	browserVersion: string;
	userAgent: string;
	platform: string;
}> {
	const started = Date.now();
	const profileDir = join(tempRoot, `${engine}-profile`);
	mkdirSync(profileDir, { recursive: true });
	let context: BrowserContext | undefined;
	let browserVersion = 'process-exited';
	let userAgent = 'unknown';
	let platform = 'unknown';
	try {
		context = await browserTypes[engine].launchPersistentContext(profileDir, {
			headless: true,
		});
		browserVersion = context.browser()?.version() ?? 'unknown';
		const page: Page = await context.newPage();
		let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
		let rejectFailure: ((cause: Error) => void) | undefined;
		const browserFailure = new Promise<never>((_resolve, reject) => {
			rejectFailure = reject;
		});
		const resetDeadline = (): void => {
			if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(
				() =>
					rejectFailure?.(
						new Error(`${engine} produced no progress for 180 seconds`),
					),
				180_000,
			);
		};
		page.on('console', (message) => {
			resetDeadline();
			process.stderr.write(`[${engine}] ${message.text()}\n`);
		});
		page.on('pageerror', (error) =>
			rejectFailure?.(new Error(`${engine} page error: ${error.message}`)),
		);
		page.on('crash', () =>
			rejectFailure?.(new Error(`${engine} page crashed`)),
		);
		await page.goto(origin);
		await page.waitForFunction(
			() => window.browserCompleteReplicaLayoutEvidence !== undefined,
		);
		({ userAgent, platform } = await page.evaluate(() => ({
			userAgent: navigator.userAgent,
			platform: navigator.platform,
		})));
		resetDeadline();
		try {
			const result = await Promise.race([
				page.evaluate(
					({ requestedProfile, runId }) =>
						window.browserCompleteReplicaLayoutEvidence.run(
							requestedProfile,
							runId,
						),
					{
						requestedProfile: profile,
						runId: `${engine}-${profile}-${Date.now()}`,
					},
				),
				browserFailure,
			]);
			return { result, browserVersion, userAgent, platform };
		} finally {
			if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
		}
	} catch (cause) {
		const finished = Date.now();
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			browserVersion,
			userAgent,
			platform,
			result: {
				outcome: 'failed',
				startedAt: new Date(started).toISOString(),
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				profile,
				parameters: COMPLETE_PROFILES[profile],
				storageEstimate: {
					requiredAvailableBytes: Math.ceil(
						COMPLETE_PROFILES[profile].proxyBytes * 1.25,
					),
				},
				runtime: {
					opfsBackend: 'sqlite.org OPFS SAH Pool VFS',
					journalMode: 'delete',
					synchronous: 'extra',
				},
				runs: [],
				reason: message,
			},
		};
	} finally {
		await context?.close().catch(() => undefined);
	}
}

async function main(): Promise<void> {
	const options = parseArguments();
	const source = sourceEvidence();
	const tempRoot = mkdtempSync(join(tmpdir(), 'epicenter-complete-layout-'));
	let server: ReturnType<typeof Bun.serve> | undefined;
	try {
		buildFixture();
		server = startFixtureServer();
		const origin = `http://${server.hostname}:${server.port}`;
		mkdirSync(options.outputDir, { recursive: true });
		for (const engine of options.engines) {
			process.stderr.write(
				`Running ${options.profile} COMPLETE replica layout on ${engine}\n`,
			);
			const started = Date.now();
			const startedAt = new Date(started).toISOString();
			const engineEvidence = await runEngine({
				engine,
				profile: options.profile,
				origin,
				tempRoot,
			});
			const finished = Date.now();
			const parameters = COMPLETE_PROFILES[options.profile];
			const report: CompleteEvidenceReport = {
				schemaVersion: 1,
				charter:
					'ADR-0177 COMPLETE wide-versus-split replica benchmark: browser OPFS',
				commit: options.commit,
				engine,
				browserVersion: engineEvidence.browserVersion,
				startedAt,
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				profile: options.profile,
				parameters,
				runtime: {
					bun: Bun.version,
					playwright: playwrightVersion,
					userAgent: engineEvidence.userAgent,
					platform: engineEvidence.platform,
					...(engineEvidence.result.runtime.sqliteVersion === undefined
						? {}
						: { sqlite: engineEvidence.result.runtime.sqliteVersion }),
				},
				source,
				fixture: {
					documents: parameters.documents,
					documentsWithSecondUpdate: Math.ceil(parameters.records / 200),
					activeDocumentInflight: parameters.documentInflight,
					blobMemberships: parameters.blobs,
					pendingIntents: parameters.pendingIntents,
					parkedIntents: parameters.parkedIntents,
					disclosures: COMPLETE_SEEDING_DISCLOSURES,
				},
				measurement: {
					timing:
						'milliseconds; per-address for pointRead, laneWrite, and docAppend; per operation for all other metrics',
					statementCounts:
						'run() and all() calls observed at the production SqliteDatabase adapter, retained per raw timing sample',
					rowsCounterLimitation:
						'SQLite embedded APIs expose no rows-read/rows-written counters; statement counts and query plans are the measurable proxies.',
					measuredSqlBoundary:
						'Direct measured SQL is limited to traversal, traversalScalar, docDrainScan, and blobDrainScan. Every measured state transition and reopen uses the production store APIs.',
				},
				workloadDecisions: [
					'Smoke uses one candidate repetition and reduced per-metric samples; full uses two repetitions and alternates candidate order across repetitions.',
					'Lane writes alternate confirmed existing addresses and benchmark-only fresh addresses within every batch.',
					'Fact-install pages alternate updates to confirmed fixture addresses and fresh addresses.',
					'Tombstone pages walk eligible multiples of 100 from the end of the fixture, then restore a pending intent before timing so every target owns document, blob, and intent state.',
					'Relation counts include every installed user table, including the shared meta relation.',
				],
				result: engineEvidence.result,
			};
			const filename = `${reportDate}-browser-complete-wide-vs-split-${options.profile}-${engine}.json`;
			const output = resolve(options.outputDir, filename);
			writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
			process.stdout.write(`${output}\n`);
		}
	} finally {
		server?.stop(true);
		rmSync(tempRoot, { recursive: true, force: true });
		rmSync(distDir, { recursive: true, force: true });
	}
}

await main();

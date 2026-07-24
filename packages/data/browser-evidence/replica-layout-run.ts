import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
	type Browser,
	type BrowserContext,
	type BrowserType,
	chromium,
	type Page,
	webkit,
} from 'playwright';

import {
	assertReplicaLayoutEvidence,
	deriveReplicaLayoutInterpretation,
	REPLICA_LAYOUT_CLEAN_SCOPE,
	REPLICA_LAYOUT_PROFILES,
	REPLICA_LAYOUT_PROVENANCE_LIMITATION,
	type ReplicaLayoutEngine,
	type ReplicaLayoutEngineResult,
	type ReplicaLayoutEvidenceReport,
	type ReplicaLayoutProfile,
} from './replica-layout-contract.js';

const evidenceDir = import.meta.dirname;
const repoRoot = resolve(evidenceDir, '../../..');
const distDir = resolve(evidenceDir, 'dist/replica-layout');
const require = createRequire(import.meta.url);
const playwrightVersion = (
	JSON.parse(
		readFileSync(require.resolve('playwright/package.json'), 'utf8'),
	) as {
		version: string;
	}
).version;

const browserTypes: Record<ReplicaLayoutEngine, BrowserType<Browser>> = {
	chromium,
	webkit,
};

function parseArguments(): {
	profile: ReplicaLayoutProfile;
	engines: ReplicaLayoutEngine[];
	output?: string;
} {
	let profile: ReplicaLayoutProfile | undefined;
	const engines: ReplicaLayoutEngine[] = [];
	let output: string | undefined;
	for (let index = 2; index < Bun.argv.length; index += 1) {
		const argument = Bun.argv[index];
		if (argument === '--profile') {
			const value = Bun.argv[index + 1];
			if (value !== 'smoke' && value !== 'full') {
				throw new Error("--profile must be explicitly 'smoke' or 'full'");
			}
			profile = value;
			index += 1;
			continue;
		}
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
			if (value === undefined) throw new Error('--output requires a file path');
			output = resolve(process.cwd(), value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown replica layout argument '${String(argument)}'`);
	}
	if (profile === undefined) {
		throw new Error(
			"Choose an explicit profile with '--profile smoke' or '--profile full'",
		);
	}
	return {
		profile,
		engines:
			engines.length === 0 ? ['chromium', 'webkit'] : [...new Set(engines)],
		...(output === undefined ? {} : { output }),
	};
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

function sha256Bytes(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path: string): string {
	return sha256Bytes(new Uint8Array(readFileSync(path)));
}

function harnessFiles(): string[] {
	const evidenceFiles = readdirSync(evidenceDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith('replica-layout-') &&
				(entry.name.endsWith('.ts') || entry.name.endsWith('.html')),
		)
		.map(({ name }) => resolve(evidenceDir, name))
		.sort();
	return [resolve(evidenceDir, '../package.json'), ...evidenceFiles];
}

function sourceProvenance(): ReplicaLayoutEvidenceReport['source'] {
	const files = harnessFiles().map((path) => ({
		path: relative(repoRoot, path),
		sha256: sha256File(path),
	}));
	const harnessHash = createHash('sha256');
	for (const file of files) {
		harnessHash.update(file.path);
		harnessHash.update('\0');
		harnessHash.update(file.sha256);
		harnessHash.update('\0');
	}
	const fingerprintedPaths = new Set([
		...files.map(({ path }) => path),
		'bun.lock',
	]);
	const dirtyPaths = git(['status', '--short'])
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(3))
		.filter((path) => fingerprintedPaths.has(path));
	return {
		commit: git(['rev-parse', 'HEAD']),
		clean: dirtyPaths.length === 0,
		cleanScope: REPLICA_LAYOUT_CLEAN_SCOPE,
		dirtyPaths,
		lockfileSha256: sha256File(resolve(repoRoot, 'bun.lock')),
		harnessSha256: harnessHash.digest('hex'),
		files,
	};
}

function buildFixture(): void {
	const result = Bun.spawnSync(
		['bun', 'x', 'vite', 'build', '--config', 'replica-layout-vite.config.ts'],
		{
			cwd: evidenceDir,
			stdout: 'inherit',
			stderr: 'inherit',
		},
	);
	if (!result.success)
		throw new Error('Browser replica layout fixture build failed');
}

function startFixtureServer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const pathname =
				url.pathname === '/' ? '/replica-layout-index.html' : url.pathname;
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
	engine: ReplicaLayoutEngine;
	profile: ReplicaLayoutProfile;
	origin: string;
	tempRoot: string;
}): Promise<ReplicaLayoutEvidenceReport['engines'][number]> {
	const engineStarted = Date.now();
	const profileDir = join(tempRoot, `${engine}-profile`);
	mkdirSync(profileDir, { recursive: true });
	let context: BrowserContext | undefined;
	let userAgent = 'unknown';
	let platform = 'unknown';
	try {
		context = await browserTypes[engine].launchPersistentContext(profileDir, {
			headless: true,
		});
		const page: Page = await context.newPage();
		let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
		let rejectBrowserFailure: ((cause: Error) => void) | undefined;
		const browserFailure = new Promise<never>((_resolve, reject) => {
			rejectBrowserFailure = reject;
		});
		const resetInactivityDeadline = (): void => {
			if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(
				() =>
					rejectBrowserFailure?.(
						new Error(
							`${engine} produced no benchmark progress for 180 seconds`,
						),
					),
				180_000,
			);
		};
		page.on('console', (message) => {
			resetInactivityDeadline();
			process.stderr.write(`[${engine}] ${message.text()}\n`);
		});
		page.on('pageerror', (error) =>
			process.stderr.write(
				`[${engine}] page error: ${error.stack ?? error.message}\n`,
			),
		);
		page.on('crash', () =>
			rejectBrowserFailure?.(
				new Error(`${engine} page crashed during benchmark`),
			),
		);
		page.on('close', () =>
			rejectBrowserFailure?.(
				new Error(`${engine} page closed during benchmark`),
			),
		);
		context.on('close', () =>
			rejectBrowserFailure?.(
				new Error(`${engine} context closed during benchmark`),
			),
		);
		await page.goto(origin);
		await page.waitForFunction(
			() => window.browserReplicaLayoutEvidence !== undefined,
		);
		({ userAgent, platform } = await page.evaluate(() => ({
			userAgent: navigator.userAgent,
			platform: navigator.platform,
		})));
		const runId = `${engine}-${profile}-${Date.now()}`;
		resetInactivityDeadline();
		let result: ReplicaLayoutEngineResult;
		try {
			result = await Promise.race([
				page.evaluate(
					({ requestedProfile, requestedRunId }) =>
						window.browserReplicaLayoutEvidence.run(
							requestedProfile,
							requestedRunId,
						),
					{ requestedProfile: profile, requestedRunId: runId },
				),
				browserFailure,
			]);
		} finally {
			if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
		}
		return {
			engine,
			browserVersion: context.browser()?.version() ?? 'unknown',
			userAgent,
			platform,
			headless: true,
			persistentProfile: true,
			origin,
			result,
			interpretation: deriveReplicaLayoutInterpretation(profile, result),
		};
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const engineFinished = Date.now();
		return {
			engine,
			browserVersion: context?.browser()?.version() ?? 'process-exited',
			userAgent,
			platform,
			headless: true,
			persistentProfile: true,
			origin,
			result: {
				outcome: 'failed',
				startedAt: new Date(engineStarted).toISOString(),
				finishedAt: new Date(engineFinished).toISOString(),
				durationMs: engineFinished - engineStarted,
				profile,
				parameters: REPLICA_LAYOUT_PROFILES[profile],
				storageEstimate: {
					requiredAvailableBytes: Math.ceil(
						REPLICA_LAYOUT_PROFILES[profile].proxyBytes * 1.25,
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
			interpretation: [`The ${profile} charter failed: ${message}.`],
		};
	} finally {
		await context?.close().catch(() => undefined);
	}
}

async function main(): Promise<void> {
	const options = parseArguments();
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const source = sourceProvenance();
	const tempRoot = mkdtempSync(join(tmpdir(), 'epicenter-replica-layout-'));
	let server: ReturnType<typeof Bun.serve> | undefined;
	try {
		buildFixture();
		server = startFixtureServer();
		const origin = `http://${server.hostname}:${server.port}`;
		const engines = [] as ReplicaLayoutEvidenceReport['engines'];
		for (const engine of options.engines) {
			process.stderr.write(
				`Running ${options.profile} replica layout on ${engine}\n`,
			);
			engines.push(
				await runEngine({
					engine,
					profile: options.profile,
					origin,
					tempRoot,
				}),
			);
		}
		const finished = Date.now();
		const report: ReplicaLayoutEvidenceReport = {
			schemaVersion: 'epicenter-browser-replica-layout-evidence/v1',
			kind: 'epicenter-browser-replica-layout-evidence',
			scope: 'pre-physical-browser-engine',
			decisionEligible: false,
			startedAt,
			finishedAt: new Date(finished).toISOString(),
			durationMs: finished - started,
			charter: 'ADR-0177 wide-versus-split hot paths: browser OPFS slice',
			profile: options.profile,
			source,
			playwrightVersion,
			engines,
			limitations: [
				REPLICA_LAYOUT_PROVENANCE_LIMITATION,
				'Headless Playwright Chromium and WebKit are desktop browser-engine evidence, not physical iOS Safari or Android Chrome evidence.',
				'Playwright WebKit is not a substitute for Safari on iOS hardware.',
				'Browser capacity and close/reopen timing vary with device storage, operating system, and browser quota policy.',
				...(options.profile === 'smoke'
					? [
							'Smoke scale validates the harness and cannot freeze inclusive V1 constants.',
						]
					: []),
			],
			overall: engines.every(({ result }) => result.outcome === 'passed')
				? 'provisional'
				: 'incomplete',
		};
		assertReplicaLayoutEvidence(report);
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		if (options.output !== undefined) {
			mkdirSync(dirname(options.output), { recursive: true });
			writeFileSync(options.output, serialized);
		}
		process.stdout.write(serialized);
	} finally {
		server?.stop(true);
		rmSync(tempRoot, { recursive: true, force: true });
		rmSync(distDir, { recursive: true, force: true });
	}
}

await main();

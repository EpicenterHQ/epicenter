#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalize, utf8ByteLength } from '@epicenter/data/protocol/v1';
import { Miniflare } from 'miniflare';

type Profile = {
	records: number;
	proxyBytes: number;
	repetitions: number;
	batchSize: number;
	seedBatch: number;
};

const MIB = 1024 * 1024;
const PROFILES = {
	smoke: {
		records: 5_000,
		proxyBytes: MIB,
		repetitions: 4,
		batchSize: 32,
		seedBatch: 1_000,
	},
	full: {
		records: 1_000_000,
		proxyBytes: 512 * MIB,
		repetitions: 128,
		batchSize: 64,
		seedBatch: 5_000,
	},
} as const satisfies Record<string, Profile>;

function addressAt(index: number) {
	const namespace = `so.epicenter.fixture${String(index % 25).padStart(2, '0')}`;
	return {
		namespace,
		collection:
			index % 100 === 0
				? 'settings'
				: `records${String(Math.floor(index / 25) % 40).padStart(2, '0')}`,
		recordKey:
			index % 100 === 0
				? `value${index}`
				: index.toString(36).padStart(24, '0'),
	};
}

function fixtureShape(profile: Profile) {
	let emptyProxyBytes = 0;
	for (let index = 0; index < profile.records; index += 1) {
		const payload = index % 100 === 0 ? '' : { body: '' };
		emptyProxyBytes += utf8ByteLength(
			canonicalize({ address: addressAt(index), payload }),
		);
	}
	const fillerBytes = profile.proxyBytes - emptyProxyBytes;
	if (fillerBytes < 0) throw new Error('proxy target is below empty fixture');
	return {
		baseFillerBytes: Math.floor(fillerBytes / profile.records),
		extraFillerRecords: fillerBytes % profile.records,
	};
}

async function command(
	worker: BenchmarkWorker,
	candidate: 'wide' | 'split',
	body: Record<string, unknown>,
) {
	const response = await worker.fetch(`/?candidate=${candidate}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const value = (await response.json()) as unknown;
	if (!response.ok) throw new Error(JSON.stringify(value));
	return value;
}

function parseArgs() {
	const profileFlag = process.argv.indexOf('--profile');
	const outputFlag = process.argv.indexOf('--output');
	const orderFlag = process.argv.indexOf('--order');
	const profileName =
		profileFlag === -1 ? 'smoke' : process.argv[profileFlag + 1];
	if (profileName !== 'smoke' && profileName !== 'full') {
		throw new Error('--profile must be smoke or full');
	}
	const orderName =
		orderFlag === -1 ? 'wide-first' : process.argv[orderFlag + 1];
	if (orderName !== 'wide-first' && orderName !== 'split-first') {
		throw new Error('--order must be wide-first or split-first');
	}
	return {
		name: profileName,
		profile: PROFILES[profileName],
		orderName,
		candidateOrder:
			orderName === 'wide-first'
				? (['wide', 'split'] as const)
				: (['split', 'wide'] as const),
		output: outputFlag === -1 ? undefined : process.argv[outputFlag + 1],
	};
}

const options = parseArgs();
const shape = fixtureShape(options.profile);
const persistence = mkdtempSync(join(tmpdir(), 'epicenter-do-layout-'));
const buildDirectory = mkdtempSync(join(tmpdir(), 'epicenter-do-layout-code-'));
const entry = join(import.meta.dir, 'authority-layout-worker.ts');
const builtEntry = join(buildDirectory, 'authority-layout-worker.js');

function progress(message: string) {
	process.stderr.write(`[authority-layout] ${message}\n`);
}

async function sha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(await Bun.file(path).arrayBuffer());
	return hasher.digest('hex');
}

type BenchmarkWorker = {
	fetch(
		input: string,
		init: { method: string; headers: Record<string, string>; body: string },
	): Promise<{ ok: boolean; json(): Promise<unknown> }>;
	stop(): Promise<void>;
};

async function startWorker() {
	const worker = new Miniflare({
		compatibilityDate: '2026-03-06',
		durableObjects: {
			LAYOUT: { className: 'AuthorityLayoutBenchmark', useSQLite: true },
		},
		durableObjectsPersist: persistence,
		modules: true,
		modulesRoot: buildDirectory,
		scriptPath: builtEntry,
	});
	await worker.ready;
	return {
		fetch(
			input: string,
			init: { method: string; headers: Record<string, string>; body: string },
		) {
			// Miniflare carries its own undici declarations. Runtime Request and
			// Response shapes are web-compatible, but the duplicate types are not.
			return worker.dispatchFetch(
				new URL(input, 'http://benchmark.local'),
				init as never,
			) as unknown as Promise<{
				ok: boolean;
				json(): Promise<unknown>;
			}>;
		},
		stop() {
			return worker.dispose();
		},
	} satisfies BenchmarkWorker;
}

let worker: BenchmarkWorker | undefined;

try {
	progress(`starting ${options.name} profile (${options.orderName})`);
	const build = await Bun.build({
		entrypoints: [entry],
		external: ['cloudflare:workers'],
		outdir: buildDirectory,
		target: 'browser',
	});
	if (!build.success) {
		throw new AggregateError(build.logs, 'benchmark worker bundle failed');
	}
	const fingerprints = {
		runnerSha256: await sha256(import.meta.path),
		workerSha256: await sha256(entry),
		authoritySchemaSha256: await sha256(
			join(import.meta.dir, '../authority-v1-schema.ts'),
		),
		bundleSha256: await sha256(builtEntry),
	};
	worker = await startWorker();
	progress('worker ready');
	const candidates: Record<string, unknown> = {};
	for (const candidate of options.candidateOrder) {
		const candidateStarted = performance.now();
		progress(`${candidate}: initializing`);
		await command(worker, candidate, {
			command: 'initialize',
			candidate,
			records: options.profile.records,
			...shape,
		});
		const seed: unknown[] = [];
		const progressEvery = Math.max(
			options.profile.seedBatch,
			Math.ceil(options.profile.records / 20 / options.profile.seedBatch) *
				options.profile.seedBatch,
		);
		for (
			let start = 0;
			start < options.profile.records;
			start += options.profile.seedBatch
		) {
			seed.push(
				await command(worker, candidate, {
					command: 'seed',
					start,
					count: Math.min(
						options.profile.seedBatch,
						options.profile.records - start,
					),
				}),
			);
			const complete = Math.min(
				start + options.profile.seedBatch,
				options.profile.records,
			);
			if (
				complete % progressEvery === 0 ||
				complete === options.profile.records
			) {
				progress(`${candidate}: seeded ${complete}/${options.profile.records}`);
			}
		}
		progress(`${candidate}: measuring`);
		candidates[candidate] = {
			seed,
			measurement: await command(worker, candidate, {
				command: 'measure',
				repetitions: options.profile.repetitions,
				batchSize: options.profile.batchSize,
			}),
		};
		progress(
			`${candidate}: complete in ${Math.round(performance.now() - candidateStarted)}ms`,
		);
	}

	progress('restarting worker against persisted storage');
	await worker.stop();
	const reopenStarted = performance.now();
	worker = await startWorker();
	const processReopenMs = performance.now() - reopenStarted;
	for (const candidate of options.candidateOrder) {
		const started = performance.now();
		const inspection = await command(worker, candidate, { command: 'inspect' });
		(candidates[candidate] as Record<string, unknown>).reopen = {
			processReopenMs,
			firstRequestMs: performance.now() - started,
			inspection,
		};
	}

	const report = {
		generatedAt: new Date().toISOString(),
		profile: options.name,
		candidateOrder: options.candidateOrder,
		fixture: { ...options.profile, ...shape },
		environment: {
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model ?? 'unknown',
			bun: Bun.version,
			miniflare: '4.20260401.0',
			workerd: '1.20260401.1',
		},
		fingerprints,
		candidates,
	};
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output === undefined) process.stdout.write(json);
	else {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, json);
	}
	progress(
		options.output === undefined ? 'report ready' : `wrote ${options.output}`,
	);
} finally {
	await worker?.stop();
	rmSync(persistence, { recursive: true, force: true });
	rmSync(buildDirectory, { recursive: true, force: true });
}

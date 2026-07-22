/**
 * Scalar V1 Production Durable Object Tests
 *
 * Bundles the production `DataAuthority` and runs it inside Miniflare/workerd
 * with SQLite-backed Durable Object persistence. Unlike the adapter unit fake,
 * this exercises Cloudflare's platform SQLite tables, RPC boundary, actor
 * construction, storage transaction API, process reopen, and `deleteAll()`.
 *
 * Key behaviors:
 * - a fresh production actor initializes and accepts an exact retry once
 * - facts, witness, and lifetime survive a workerd dispose/reopen cycle
 * - account deletion atomically opens an empty successor lifetime
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
	AuthorityError,
	FactsResponse,
	SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import { Miniflare } from 'miniflare';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

const ADDRESS = {
	namespace: 'so.epicenter.whispering',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

type WorkerdResponse = {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
};

type AuthorityCommand = {
	object: string;
	operation: 'deleteAccount' | 'readFacts' | 'submit';
	request?: unknown;
};

async function setup(object: string) {
	const persistence = mkdtempSync(join(tmpdir(), 'epicenter-data-authority-'));
	const buildDirectory = mkdtempSync(
		join(tmpdir(), 'epicenter-data-authority-code-'),
	);

	function buildWorker(sourceName: string): string {
		const entry = join(import.meta.dir, sourceName);
		const builtEntry = join(buildDirectory, sourceName.replace(/\.ts$/, '.js'));
		const build = Bun.spawnSync({
			cmd: [
				process.execPath,
				'build',
				entry,
				`--outfile=${builtEntry}`,
				'--target=browser',
				'--external=cloudflare:workers',
			],
			cwd: join(import.meta.dir, '../../../..'),
			stderr: 'pipe',
			stdout: 'pipe',
		});
		if (build.exitCode !== 0) {
			throw new Error(
				`DataAuthority test worker build failed:\n${build.stderr.toString()}`,
			);
		}
		return builtEntry;
	}

	let builtEntry: string;
	let seederEntry: string;
	try {
		builtEntry = buildWorker('scalar-v1-miniflare-worker.test-support.ts');
		seederEntry = buildWorker('scalar-v1-kv-seeder-worker.test-support.ts');
	} catch (cause) {
		rmSync(persistence, { recursive: true, force: true });
		rmSync(buildDirectory, { recursive: true, force: true });
		throw cause;
	}

	let worker: Miniflare | undefined;
	async function cleanup(): Promise<void> {
		await worker?.dispose();
		worker = undefined;
		rmSync(persistence, { recursive: true, force: true });
		rmSync(buildDirectory, { recursive: true, force: true });
	}

	async function start(scriptPath = builtEntry): Promise<Miniflare> {
		worker = new Miniflare({
			compatibilityDate: '2026-03-06',
			durableObjects: {
				DATA_AUTHORITY: { className: 'DataAuthority', useSQLite: true },
			},
			durableObjectsPersist: persistence,
			modules: true,
			modulesRoot: buildDirectory,
			r2Buckets: ['DATA_BLOBS'],
			r2Persist: persistence,
			scriptPath,
		});
		await worker.ready;
		return worker;
	}

	let seededBody: { objects: string[] };
	try {
		const seeder = await start(seederEntry);
		const seeded = (await seeder.dispatchFetch('http://authority.test', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ object, operation: 'seed' }),
		})) as unknown as WorkerdResponse;
		if (!seeded.ok) throw new Error('failed to seed the platform KV table');
		seededBody = (await seeded.json()) as { objects: string[] };
		if (!seededBody.objects.includes('table:_cf_KV')) {
			throw new Error(
				`platform KV seed did not create _cf_KV: ${seededBody.objects.join(', ')}`,
			);
		}
		await seeder.dispose();
		worker = undefined;
		await start();
	} catch (cause) {
		await cleanup();
		throw cause;
	}
	return {
		platformObjects: seededBody.objects,
		async command<T>(command: AuthorityCommand): Promise<T> {
			if (worker === undefined) throw new Error('test worker is not running');
			const response = (await worker.dispatchFetch('http://authority.test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(command),
			})) as unknown as WorkerdResponse;
			if (!response.ok) {
				throw new Error(
					`workerd authority command failed (${response.status}; seeded ${seededBody.objects.join(', ')}): ${await response.text()}`,
				);
			}
			return (await response.json()) as T;
		},
		async restart(): Promise<void> {
			await worker?.dispose();
			worker = undefined;
			await start();
		},
		async hasPlatformSeed(): Promise<boolean> {
			await worker?.dispose();
			worker = undefined;
			const inspector = await start(seederEntry);
			const inspected = (await inspector.dispatchFetch(
				'http://authority.test',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ object, operation: 'inspect' }),
				},
			)) as unknown as WorkerdResponse;
			if (!inspected.ok)
				throw new Error('failed to inspect the platform KV key');
			const body = (await inspected.json()) as { hasPlatformSeed: boolean };
			await inspector.dispose();
			worker = undefined;
			await start();
			return body.hasPlatformSeed;
		},
		async close(): Promise<void> {
			await cleanup();
		},
	};
}

type FactsResult = Result<FactsResponse, AuthorityError>;
type SubmissionResult = Result<SubmissionResponse, AuthorityError>;

test('production DataAuthority persists retry state and deleteAll opens a fresh lifetime', async () => {
	const object = 'principal-production-proof';
	const harness = await setup(object);
	try {
		expect(harness.platformObjects).toContain('table:_cf_KV');
		const initial = expectOk(
			await harness.command<FactsResult>({
				object,
				operation: 'readFacts',
				request: { afterSequence: 0 },
			}),
		);
		expect(initial.facts).toEqual([]);
		expect(initial.hasMore).toBe(false);

		const submission = {
			authorityLifetime: initial.authorityLifetime,
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			submissionNumber: 1,
			intents: [
				{
					address: ADDRESS,
					op: 'replace',
					value: { title: 'workerd' },
				},
			],
		};
		const accepted = expectOk(
			await harness.command<SubmissionResult>({
				object,
				operation: 'submit',
				request: submission,
			}),
		);
		expect(accepted.facts).toEqual([
			{
				address: ADDRESS,
				sequence: 1,
				state: 'live',
				payload: { title: 'workerd' },
			},
		]);
		expect(
			expectOk(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: submission,
				}),
			),
		).toEqual(accepted);

		await harness.restart();
		expect(
			expectOk(
				await harness.command<FactsResult>({
					object,
					operation: 'readFacts',
					request: {
						authorityLifetime: initial.authorityLifetime,
						afterSequence: 0,
					},
				}),
			),
		).toEqual({ ...initial, facts: accepted.facts });
		expect(
			expectOk(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: submission,
				}),
			),
		).toEqual(accepted);

		await harness.command<{ deleted: true }>({
			object,
			operation: 'deleteAccount',
		});
		expect(await harness.hasPlatformSeed()).toBe(false);
		const successor = expectOk(
			await harness.command<FactsResult>({
				object,
				operation: 'readFacts',
				request: { afterSequence: 0 },
			}),
		);
		expect(successor.authorityLifetime).not.toBe(initial.authorityLifetime);
		expect(successor.facts).toEqual([]);

		await harness.restart();
		expect(
			expectOk(
				await harness.command<FactsResult>({
					object,
					operation: 'readFacts',
					request: { afterSequence: 0 },
				}),
			),
		).toEqual(successor);
	} finally {
		await harness.close();
	}
});

test('production DataAuthority preserves lifetime, fork, gap, parked, and tombstone refusals', async () => {
	const object = 'principal-semantic-proof';
	const harness = await setup(object);
	try {
		expect(harness.platformObjects).toContain('table:_cf_KV');
		const initial = expectOk(
			await harness.command<FactsResult>({
				object,
				operation: 'readFacts',
				request: { afterSequence: 0 },
			}),
		);
		const base = {
			authorityLifetime: initial.authorityLifetime,
			replicaId: 'ssssssssssssssssssssssss',
		};
		const first = {
			...base,
			submissionNumber: 1,
			intents: [{ address: ADDRESS, op: 'replace', value: 1 }],
		};
		expectOk(
			await harness.command<SubmissionResult>({
				object,
				operation: 'submit',
				request: first,
			}),
		);

		expect(
			expectErr(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: { ...first, authorityLifetime: 'wrong-lifetime' },
				}),
			).name,
		).toBe('LifetimeMismatch');
		expect(
			expectErr(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: {
						...first,
						intents: [{ address: ADDRESS, op: 'replace', value: 2 }],
					},
				}),
			).name,
		).toBe('SubmissionFork');
		expect(
			expectErr(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: {
						...base,
						submissionNumber: 3,
						intents: [{ address: ADDRESS, op: 'replace', value: 3 }],
					},
				}),
			).name,
		).toBe('SubmissionGap');

		const parkedRequest = {
			...base,
			submissionNumber: 2,
			intents: [
				{
					address: ADDRESS,
					op: 'patch',
					set: { title: 'cannot-patch-number' },
					unset: [],
				},
			],
		};
		const parked = expectOk(
			await harness.command<SubmissionResult>({
				object,
				operation: 'submit',
				request: parkedRequest,
			}),
		);
		expect(parked.parked).toEqual([
			{ address: ADDRESS, code: 'patch-base-not-object' },
		]);
		expect(
			expectOk(
				await harness.command<SubmissionResult>({
					object,
					operation: 'submit',
					request: parkedRequest,
				}),
			),
		).toEqual(parked);

		const tombstone = expectOk(
			await harness.command<SubmissionResult>({
				object,
				operation: 'submit',
				request: {
					...base,
					submissionNumber: 3,
					intents: [{ address: ADDRESS, op: 'tombstone' }],
				},
			}),
		);
		expect(tombstone.facts[0]).toMatchObject({
			address: ADDRESS,
			state: 'tombstone',
			sequence: 2,
		});
		const absorbed = expectOk(
			await harness.command<SubmissionResult>({
				object,
				operation: 'submit',
				request: {
					...base,
					submissionNumber: 4,
					intents: [
						{ address: ADDRESS, op: 'replace', value: 'cannot-return' },
					],
				},
			}),
		);
		expect(absorbed.facts[0]).toMatchObject({
			address: ADDRESS,
			state: 'tombstone',
			sequence: 2,
		});
	} finally {
		await harness.close();
	}
});

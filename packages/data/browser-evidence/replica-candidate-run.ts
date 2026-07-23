import { rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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
import type {
	BrowserReplicaCandidateStart,
	BrowserReplicaCandidateStatus,
} from '../src/store/replica/browser-candidate-protocol.js';
import type { BrowserReplicaStoreOperation } from '../src/store/replica/browser-owner-protocol.js';

const evidenceDir = import.meta.dirname;
const distDir = resolve(evidenceDir, 'dist');
const replicaId = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const authorityLifetime = 'lifetime-one';
const addressA: RecordAddress = {
	namespace: 'so.epicenter.evidence',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const addressB: RecordAddress = {
	namespace: 'so.epicenter.evidence',
	collection: 'records',
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};
const addressC: RecordAddress = {
	namespace: 'so.epicenter.evidence',
	collection: 'records',
	recordKey: 'cccccccccccccccccccccccc',
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
	{ cwd: evidenceDir, stdout: 'inherit', stderr: 'inherit' },
);
if (!build.success) throw new Error('Browser replica candidate build failed');

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
		return new Response(file);
	},
});

async function openPage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.waitForFunction(
		() => window.browserReplicaCandidateEvidence !== undefined,
	);
	return page;
}

async function openCandidate(
	page: Page,
	options: Omit<BrowserReplicaCandidateStart, 'type'>,
): Promise<void> {
	await page.evaluate(
		(optionsJson) =>
			window.browserReplicaCandidateEvidence.open(
				JSON.parse(optionsJson) as Omit<BrowserReplicaCandidateStart, 'type'>,
			),
		JSON.stringify(options),
	);
}

async function request(page: Page, operation: BrowserReplicaStoreOperation) {
	return page.evaluate(
		(operationJson) =>
			window.browserReplicaCandidateEvidence.request(
				JSON.parse(operationJson) as BrowserReplicaStoreOperation,
			),
		JSON.stringify(operation),
	);
}

async function status(page: Page): Promise<BrowserReplicaCandidateStatus> {
	return page.evaluate(() => window.browserReplicaCandidateEvidence.status());
}

async function waitForStatus(
	page: Page,
	accept: (status: BrowserReplicaCandidateStatus) => boolean,
	label: string,
): Promise<BrowserReplicaCandidateStatus> {
	const deadline = Date.now() + 15_000;
	let observed = await status(page);
	while (!accept(observed)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(25);
		observed = await status(page);
	}
	return observed;
}

async function waitForInvalidations(
	page: Page,
	count: number,
): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	const tokens: string[] = [];
	while (tokens.length < count) {
		tokens.push(
			...(await page.evaluate(() =>
				window.browserReplicaCandidateEvidence.takeInvalidations(),
			)),
		);
		if (tokens.length >= count) break;
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${count} invalidations`);
		await Bun.sleep(25);
	}
	return tokens;
}

async function runEngine(
	engineName: string,
	engine: BrowserType,
	profileRoot: string,
): Promise<void> {
	const profile = resolve(profileRoot, engineName);
	let context = await engine.launchPersistentContext(profile, {
		headless: true,
	});
	const runId = `${Date.now()}-${engineName}`;
	const options = {
		limits: makeLimits(),
		owner: null,
		initialize: { replicaId, authorityLifetime },
		coordinationId: `epicenter-replica-candidate-${runId}`,
		storage: {
			databaseFilename: '/replica.sqlite3',
			poolDirectory: `.epicenter-replica-candidate-${runId}`,
			poolName: `epicenter-replica-candidate-${runId}`,
		},
	};
	const first = await openPage(context);
	const second = await openPage(context);
	await Promise.all([
		openCandidate(first, options),
		openCandidate(second, options),
	]);
	const firstStatus = await status(first);
	const secondStatus = await status(second);
	assert(
		[firstStatus.role, secondStatus.role].filter((role) => role === 'owner')
			.length === 1,
		`${engineName} did not elect exactly one owner`,
	);
	assert(
		firstStatus.ownerSession === secondStatus.ownerSession,
		`${engineName} candidates disagreed on the owner session`,
	);
	const ownerPage = firstStatus.role === 'owner' ? first : second;
	const followerPage = ownerPage === first ? second : first;

	await Promise.all([
		request(ownerPage, {
			kind: 'local-write',
			intent: { address: addressA, op: 'replace', value: 'from-owner' },
		}),
		request(followerPage, {
			kind: 'local-write',
			intent: { address: addressB, op: 'replace', value: 'from-follower' },
		}),
	]);
	const [ownerInvalidations, followerInvalidations] = await Promise.all([
		waitForInvalidations(ownerPage, 2),
		waitForInvalidations(followerPage, 2),
	]);
	assert(
		new Set(ownerInvalidations).size === 2 &&
			new Set(followerInvalidations).size === 2 &&
			ownerInvalidations.every((token) =>
				followerInvalidations.includes(token),
			),
		`${engineName} did not deliver each committed invalidation exactly once`,
	);
	const ownerSession = firstStatus.ownerSession;
	await ownerPage.close();
	const promoted = await waitForStatus(
		followerPage,
		(value) => value.role === 'owner' && value.ownerSession !== ownerSession,
		`${engineName} owner-page takeover`,
	);
	await request(followerPage, { kind: 'integrity-check' });
	const retained = await request(followerPage, {
		kind: 'record',
		address: addressA,
	});
	assert(retained !== null, `${engineName} takeover lost committed state`);

	const replacement = await openPage(context);
	await openCandidate(replacement, options);
	const replacementStatus = await status(replacement);
	assert(
		replacementStatus.role === 'follower' &&
			replacementStatus.ownerSession === promoted.ownerSession,
		`${engineName} replacement did not join as a follower`,
	);
	await replacement.evaluate(
		({ blockerJson, mutationJson }) => {
			const target = window as typeof window & { ownerLossProbe?: string };
			target.ownerLossProbe = 'pending';
			const blocker = JSON.parse(blockerJson) as BrowserReplicaStoreOperation;
			for (let index = 0; index < 1_000; index += 1) {
				void window.browserReplicaCandidateEvidence
					.request(blocker)
					.catch(() => undefined);
			}
			void window.browserReplicaCandidateEvidence
				.request(JSON.parse(mutationJson) as BrowserReplicaStoreOperation)
				.then(
					() => {
						target.ownerLossProbe = 'resolved';
					},
					(cause: unknown) => {
						target.ownerLossProbe =
							cause instanceof Error ? cause.name : 'Error';
					},
				);
		},
		{
			blockerJson: JSON.stringify({
				kind: 'record',
				address: addressA,
			} satisfies BrowserReplicaStoreOperation),
			mutationJson: JSON.stringify({
				kind: 'local-write',
				intent: {
					address: addressC,
					op: 'replace',
					value: 'must-not-replay',
				},
			} satisfies BrowserReplicaStoreOperation),
		},
	);
	await followerPage.evaluate(() =>
		window.browserReplicaCandidateEvidence.terminate(),
	);
	await waitForStatus(
		replacement,
		(value) =>
			value.role === 'owner' && value.ownerSession !== promoted.ownerSession,
		`${engineName} forced-worker takeover`,
	);
	await replacement.waitForFunction(
		() =>
			(window as typeof window & { ownerLossProbe?: string }).ownerLossProbe !==
			'pending',
	);
	const ownerLossProbe = await replacement.evaluate(
		() =>
			(window as typeof window & { ownerLossProbe?: string }).ownerLossProbe,
	);
	assert(
		ownerLossProbe === 'EpicenterBrowserOwnerLostError',
		`${engineName} pending mutation was not rejected on owner loss: ${String(
			ownerLossProbe,
		)}`,
	);
	await followerPage.close();
	await request(replacement, { kind: 'integrity-check' });
	await request(replacement, {
		kind: 'local-write',
		intent: { address: addressA, op: 'replace', value: 'after-takeover' },
	});
	await replacement.evaluate(() =>
		window.browserReplicaCandidateEvidence.close(),
	);
	await replacement.close();
	await context.close();

	context = await engine.launchPersistentContext(profile, { headless: true });
	const relaunched = await openPage(context);
	await openCandidate(relaunched, options);
	await request(relaunched, { kind: 'integrity-check' });
	const afterRelaunch = await request(relaunched, {
		kind: 'record',
		address: addressA,
	});
	assert(
		JSON.stringify(afterRelaunch).includes('after-takeover'),
		`${engineName} profile relaunch lost the semantic witness`,
	);
	await relaunched.evaluate(() =>
		window.browserReplicaCandidateEvidence.close(),
	);
	await relaunched.close();
	await context.close();
	console.log(`${engineName}: elected browser replica topology passed`);
}

const profileRoot = await mkdtemp(
	resolve(tmpdir(), 'epicenter-browser-candidate-'),
);
try {
	await runEngine('chromium', chromium, profileRoot);
	await runEngine('webkit', webkit, profileRoot);
} finally {
	server.stop(true);
	rmSync(profileRoot, { recursive: true, force: true });
}

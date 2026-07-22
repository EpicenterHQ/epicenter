import { rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import * as Y from '@y/y';
import { chromium, webkit } from 'playwright';

import type { RecordAddress } from '../src/protocol/v1/index.js';

const evidenceDir = import.meta.dirname;
const distDir = resolve(evidenceDir, 'dist');
const fixture = {
	replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
	authorityLifetime: 'lifetime-one',
};
const address: RecordAddress = {
	namespace: 'so.epicenter.evidence',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function documentUpdate(value: string): number[] {
	const document = new Y.Doc({ gc: true });
	let update: Uint8Array | undefined;
	document.on('updateV2', (next: Uint8Array) => {
		update = new Uint8Array(next);
	});
	document.get('content').insert(0, value);
	document.destroy();
	if (update === undefined) throw new Error('document update was not emitted');
	return [...update];
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const build = Bun.spawnSync(
	['bun', 'x', 'vite', 'build', '--config', 'vite.config.ts'],
	{ cwd: evidenceDir, stdout: 'inherit', stderr: 'inherit' },
);
if (!build.success) throw new Error('Browser replica evidence build failed');

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

const tempDirectory = await mkdtemp(
	resolve(tmpdir(), 'epicenter-browser-replica-'),
);
try {
	for (const [engineName, engine] of [
		['chromium', chromium],
		['webkit', webkit],
	] as const) {
		const context = await engine.launchPersistentContext(
			resolve(tempDirectory, engineName),
			{ headless: true },
		);
		try {
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(
				() => window.browserReplicaOwnerEvidence !== undefined,
			);
			await page.evaluate(
				({ storageId, fixture }) =>
					window.browserReplicaOwnerEvidence.open(storageId, fixture),
				{ storageId: `${Date.now()}-${engineName}`, fixture },
			);
			await page.evaluate(
				({ address }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'local-write',
						intent: { address, op: 'replace', value: { engine: 'browser' } },
					}),
				{ address },
			);
			const before = await page.evaluate(
				({ address }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'record',
						address,
					}),
				{ address },
			);
			assert(
				JSON.stringify(before) ===
					JSON.stringify({
						confirmed: null,
						sealed: null,
						pending: { op: 'replace', value: { engine: 'browser' } },
						parked: null,
					}),
				`${engineName} browser replica write was not visible`,
			);
			const update = documentUpdate(engineName);
			await page.evaluate(
				({ address, update }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'append-local-document',
						address,
						update: new Uint8Array(update),
					}),
				{ address, update },
			);
			const documentBefore = await page.evaluate(
				({ address }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'inspect-document',
						address,
					}),
				{ address },
			);
			assert(
				documentBefore !== null &&
					typeof documentBefore === 'object' &&
					'revision' in documentBefore &&
					documentBefore.revision === 1,
				`${engineName} document append was not visible`,
			);
			await page.evaluate(() =>
				window.browserReplicaOwnerEvidence.request({ kind: 'reopen' }),
			);
			await page.evaluate(() =>
				window.browserReplicaOwnerEvidence.request({ kind: 'integrity-check' }),
			);
			const after = await page.evaluate(
				({ address }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'record',
						address,
					}),
				{ address },
			);
			assert(
				JSON.stringify(after) === JSON.stringify(before),
				`${engineName} browser replica changed after reopen`,
			);
			const documentAfter = await page.evaluate(
				({ address }) =>
					window.browserReplicaOwnerEvidence.request({
						kind: 'inspect-document',
						address,
					}),
				{ address },
			);
			assert(
				JSON.stringify(documentAfter) === JSON.stringify(documentBefore),
				`${engineName} browser document changed after reopen`,
			);
			await page.evaluate(() => window.browserReplicaOwnerEvidence.dispose());
			console.log(`${engineName}: dedicated OPFS replica owner passed`);
		} finally {
			await context.close();
		}
	}
} finally {
	server.stop(true);
	rmSync(tempDirectory, { recursive: true, force: true });
}

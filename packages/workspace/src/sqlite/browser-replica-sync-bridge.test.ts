/**
 * Browser Replica Sync Bridge Tests
 *
 * Verifies that the browser MessagePort bridge exposes only semantic
 * record-sync operations while preserving binding, cancellation, and terminal
 * refusal errors across the page and Worker boundary.
 *
 * Key behaviors:
 * - workspace binding and valid requests reach the page-owned sync port
 * - aborted Worker requests cancel page-side work
 * - protocol refusals retain their terminal error class
 */

import { expect, test } from 'bun:test';
import {
	attachBrowserReplicaSyncPort,
	createBrowserReplicaSyncPort,
} from './browser-replica-sync-bridge.js';
import type { ReplicaSyncPort } from './replica.js';
import { ReplicaSyncRefusalError } from './replica.js';

function openRequest() {
	return {
		workspaceId: 'notes-v1',
		protocolMajor: 1,
		recordsDescriptor: JSON.stringify({ tables: [] }),
		recordsSchemaHash: `sha256:${'0'.repeat(64)}`,
	};
}

test('semantic requests bind and cross the browser sync bridge', async () => {
	const calls: unknown[] = [];
	const pageSync: ReplicaSyncPort = {
		bindWorkspace(workspaceId) {
			calls.push(['bind', workspaceId]);
		},
		async openAuthority(request) {
			calls.push(['openAuthority', request]);
			return { ok: true, recordsEpoch: 'epoch-1' };
		},
		async push(request) {
			calls.push(['push', request]);
			return { ok: true };
		},
		async pull(request) {
			calls.push(['pull', request]);
			return { ok: true, mutations: [] };
		},
		async snapshotChunk(request) {
			calls.push(['snapshotChunk', request]);
			return { ok: true };
		},
	};
	const channel = new MessageChannel();
	const stop = attachBrowserReplicaSyncPort(channel.port1, pageSync);
	const workerSync = createBrowserReplicaSyncPort(channel.port2);

	workerSync.bindWorkspace('notes-v1');
	const result = await workerSync.openAuthority(openRequest());

	expect(result).toEqual({ ok: true, recordsEpoch: 'epoch-1' });
	expect(calls).toEqual([
		['bind', 'notes-v1'],
		['openAuthority', openRequest()],
	]);

	workerSync[Symbol.dispose]();
	stop();
});

test('aborting a Worker request cancels page-side sync work', async () => {
	let pageSignal: AbortSignal | undefined;
	const pageSync: ReplicaSyncPort = {
		bindWorkspace() {},
		async openAuthority() {
			return {};
		},
		async push() {
			return {};
		},
		pull(_request, signal) {
			pageSignal = signal;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener(
					'abort',
					() => reject(new Error('page request aborted')),
					{ once: true },
				);
			});
		},
		async snapshotChunk() {
			return {};
		},
	};
	const channel = new MessageChannel();
	const stop = attachBrowserReplicaSyncPort(channel.port1, pageSync);
	const workerSync = createBrowserReplicaSyncPort(channel.port2);
	workerSync.bindWorkspace('notes-v1');
	const controller = new AbortController();
	const request = workerSync.pull(
		{
			kind: 'pull',
			protocolMajor: 1,
			recordsEpoch: 'epoch-1',
			cursor: 0,
			limit: 100,
		},
		controller.signal,
	);

	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort(new Error('caller aborted'));
	await expect(request).rejects.toThrow('caller aborted');
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(pageSignal?.aborted).toBe(true);

	workerSync[Symbol.dispose]();
	stop();
});

test('terminal sync refusals retain their error class in the Worker', async () => {
	const pageSync: ReplicaSyncPort = {
		bindWorkspace() {},
		async openAuthority() {
			throw new ReplicaSyncRefusalError('protocol-mismatch');
		},
		async push() {
			return {};
		},
		async pull() {
			return {};
		},
		async snapshotChunk() {
			return {};
		},
	};
	const channel = new MessageChannel();
	const stop = attachBrowserReplicaSyncPort(channel.port1, pageSync);
	const workerSync = createBrowserReplicaSyncPort(channel.port2);
	workerSync.bindWorkspace('notes-v1');

	const error = await workerSync
		.openAuthority(openRequest())
		.catch((cause) => cause);
	expect(error).toBeInstanceOf(ReplicaSyncRefusalError);
	expect((error as ReplicaSyncRefusalError).reason).toBe('protocol-mismatch');

	workerSync[Symbol.dispose]();
	stop();
});

/**
 * Browser Row Document Registry Tests
 *
 * Exercises the page-local shared Y.Doc and its elected-owner persistence
 * barrier without creating a page-side durable store.
 *
 * Key behaviors:
 * - Concurrent handles share one Y.Doc and one persistence observer
 * - whenDurable waits for the invocation-time owner acknowledgement
 * - Owner loss rejects the tail instead of replaying the mutation
 * - Unset preserves handles while tombstone and disposal revoke them
 */
import { expect, test } from 'bun:test';
import * as Y from '@y/y';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { BrowserReplicaCandidateOperation } from '../store/replica/browser-owner-protocol.js';
import { createBrowserRowDocumentRegistry } from './browser-row-document.js';

const address: RecordAddress = {
	namespace: 'so.epicenter.runtime',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function setup({ holdFirstOpen = false } = {}) {
	let refresh:
		| { kind: 'terminal' }
		| { kind: 'preserved'; update?: Uint8Array } = {
		kind: 'preserved',
	};
	const appends: Uint8Array[] = [];
	const acknowledgements: ReturnType<typeof deferred<void>>[] = [];
	const firstOpen = deferred<void>();
	let openRequests = 0;
	const registry = createBrowserRowDocumentRegistry({
		async request<TResult>(operation: BrowserReplicaCandidateOperation) {
			switch (operation.kind) {
				case 'open-runtime-document':
					openRequests += 1;
					if (holdFirstOpen && openRequests === 1) {
						await firstOpen.promise;
					}
					return { kind: 'ready' } as TResult;
				case 'refresh-runtime-document':
					return refresh as TResult;
				case 'append-local-document': {
					appends.push(new Uint8Array(operation.update));
					const acknowledgement = deferred<void>();
					acknowledgements.push(acknowledgement);
					await acknowledgement.promise;
					return undefined as TResult;
				}
				default:
					throw new Error(`Unexpected operation '${operation.kind}'`);
			}
		},
	});
	return {
		registry,
		appends,
		acknowledgements,
		releaseFirstOpen: firstOpen.resolve,
		setRefresh(
			next: { kind: 'terminal' } | { kind: 'preserved'; update?: Uint8Array },
		) {
			refresh = next;
		},
	};
}

test('concurrent handles share one document and one owner append', async () => {
	const fixture = setup();
	const first = await fixture.registry.open(address);
	const second = await fixture.registry.open(address);
	if (first === null || second === null)
		throw new Error('document did not open');

	first.getText('body').insert(0, 'shared');
	expect(second.getText('body').toString()).toBe('shared');
	await Promise.resolve();
	expect(fixture.appends).toHaveLength(1);

	const durable = second.whenDurable();
	let settled = false;
	void durable.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBeFalse();
	fixture.acknowledgements[0]?.resolve();
	await durable;
	expect(settled).toBeTrue();

	await first[Symbol.asyncDispose]();
	await second[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('whenDurable snapshots the updates preceding its invocation', async () => {
	const fixture = setup();
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	document.getText('body').insert(0, 'a');
	const firstBarrier = document.whenDurable();
	document.getText('body').insert(1, 'b');
	await Promise.resolve();
	expect(fixture.appends).toHaveLength(1);

	fixture.acknowledgements[0]?.resolve();
	await firstBarrier;
	await Promise.resolve();
	expect(fixture.appends).toHaveLength(2);

	const secondBarrier = document.whenDurable();
	fixture.acknowledgements[1]?.resolve();
	await secondBarrier;
	await document[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('owner loss rejects durability and revokes every shared handle', async () => {
	const fixture = setup();
	const first = await fixture.registry.open(address);
	const second = await fixture.registry.open(address);
	if (first === null || second === null)
		throw new Error('document did not open');

	first.getText('body').insert(0, 'uncertain');
	const durability = second.whenDurable();
	const observed = durability.then(
		() => null,
		(cause: unknown) => cause,
	);
	while (fixture.acknowledgements.length === 0) await Promise.resolve();
	const ownerLost = new Error('owner changed');
	ownerLost.name = 'EpicenterBrowserOwnerLostError';
	fixture.acknowledgements[0]?.reject(ownerLost);

	expect(await observed).toMatchObject({
		name: 'EpicenterBrowserOwnerLostError',
	});
	expect(() => first.getText('body')).toThrow(/owner changed/);
	expect(() => second.getText('body')).toThrow(/owner changed/);
	await first[Symbol.asyncDispose]();
	await expect(second[Symbol.asyncDispose]()).rejects.toMatchObject({
		name: 'EpicenterBrowserOwnerLostError',
	});
	await fixture.registry.dispose();
});

test('unset preserves a shared document and tombstone revokes it', async () => {
	const fixture = setup();
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');
	document.getText('body').insert(0, 'retained');
	await Promise.resolve();
	fixture.acknowledgements[0]?.resolve();
	await document.whenDurable();

	fixture.setRefresh({ kind: 'preserved' });
	await fixture.registry.invalidateAll();
	expect(document.getText('body').toString()).toBe('retained');

	fixture.setRefresh({ kind: 'terminal' });
	await fixture.registry.invalidateAll();
	expect(() => document.getText('body')).toThrow(/revoked/);
	await document[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('registry disposal waits for pending durability and revokes handles', async () => {
	const fixture = setup();
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');
	document.getText('body').insert(0, 'pending');
	await Promise.resolve();

	const disposal = fixture.registry.dispose();
	let settled = false;
	void disposal.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBeFalse();
	fixture.acknowledgements[0]?.resolve();
	await disposal;
	expect(() => document.getText('body')).toThrow(/disposed/);
});

test('realtime target installs durably before live and publishes only durable local updates', async () => {
	const appends: Uint8Array[] = [];
	const installs: Uint8Array[] = [];
	const acknowledgements: ReturnType<typeof deferred<void>>[] = [];
	let target:
		| Parameters<
				NonNullable<
					Parameters<typeof createBrowserRowDocumentRegistry>[0]['realtime']
				>['attach']
		  >[1]
		| undefined;
	let detached = 0;
	const registry = createBrowserRowDocumentRegistry({
		async request<TResult>(operation: BrowserReplicaCandidateOperation) {
			switch (operation.kind) {
				case 'open-runtime-document':
					return { kind: 'ready' } as TResult;
				case 'append-local-document': {
					appends.push(new Uint8Array(operation.update));
					const acknowledgement = deferred<void>();
					acknowledgements.push(acknowledgement);
					await acknowledgement.promise;
					return undefined as TResult;
				}
				case 'install-accepted-document':
					installs.push(new Uint8Array(operation.update));
					return undefined as TResult;
				default:
					throw new Error(`Unexpected operation '${operation.kind}'`);
			}
		},
		realtime: {
			attach(attachedAddress, attachedTarget) {
				expect(attachedAddress).toEqual(address);
				target = attachedTarget;
				return () => {
					detached += 1;
				};
			},
		},
	});

	const document = await registry.open(address);
	if (document === null) throw new Error('document did not open');
	if (target === undefined) throw new Error('realtime target did not attach');

	// A local edit publishes only after the owner acknowledges durability.
	const published: Uint8Array[] = [];
	const stopObserving = target.observeLocal((update) => published.push(update));
	document.getText('body').insert(0, 'local');
	await Promise.resolve();
	expect(appends).toHaveLength(1);
	expect(published).toHaveLength(0);
	acknowledgements[0]?.resolve();
	await document.whenDurable();
	await Promise.resolve();
	expect(published).toHaveLength(1);

	// A remote accepted update installs through the owner before going live,
	// and neither persists as local work nor publishes back out.
	const remote = new Y.Doc({ gc: true });
	remote.get('body').insert(0, 'remote-');
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(remote));
	remote.destroy();
	await target.installAccepted(update);
	expect(installs).toHaveLength(1);
	// Concurrent same-position inserts merge in client-id order; the semantic
	// claim is that both sides survive the merge exactly once.
	const merged = document.getText('body').toString();
	expect(merged).toHaveLength('remote-local'.length);
	expect(merged).toContain('remote-');
	expect(merged).toContain('local');
	expect(appends).toHaveLength(1);
	await Promise.resolve();
	expect(published).toHaveLength(1);

	stopObserving();
	await document[Symbol.asyncDispose]();
	expect(detached).toBe(1);
	await registry.dispose();
});

test('authority replacement fences an in-flight old-lineage hydration', async () => {
	const fixture = setup({ holdFirstOpen: true });
	const oldOpen = fixture.registry.open(address);
	const oldOutcome = oldOpen.then(
		() => null,
		(cause: unknown) => cause,
	);
	await Promise.resolve();

	fixture.registry.revokeAll();
	const replacement = await fixture.registry.open(address);
	if (replacement === null)
		throw new Error('replacement document did not open');
	fixture.releaseFirstOpen();

	expect(await oldOutcome).toMatchObject({ name: 'RevokedDocument' });
	expect(replacement.getText('body').toString()).toBe('');
	await replacement[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

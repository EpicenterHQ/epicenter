/**
 * Browser Row Document Registry Tests
 *
 * Exercises the page-local shared Y.Doc and its elected-owner persistence
 * barrier without creating a page-side durable store.
 *
 * Key behaviors:
 * - Concurrent handles share one Y.Doc and one persistence observer
 * - whenDurable waits for the invocation-time owner acknowledgement
 * - A failed owner append rejects the tail instead of replaying the mutation
 * - Unset preserves handles while tombstone and disposal revoke them
 * - Pull installs durably before live, is conditional, and is fenced by
 *   disposal, revocation, and the generation it opened under
 */
import { expect, test } from 'bun:test';
import * as Y from '@y/y';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { BrowserReplicaOwnerRuntimeOperation } from '../store/replica/browser-owner-protocol.js';
import { createBrowserRowDocumentRegistry } from './browser-row-document.js';
import type { DocumentPuller } from './row-document.js';

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
		async request<TResult>(operation: BrowserReplicaOwnerRuntimeOperation) {
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

test('a failed owner append rejects durability and revokes every shared handle', async () => {
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
	// The owner worker answers a failed operation with a serialized error; the
	// page cannot know whether the append committed, so the handle is revoked
	// rather than replaying the mutation.
	const appendFailed = new Error('owner worker is closed');
	fixture.acknowledgements[0]?.reject(appendFailed);

	expect(await observed).toBe(appendFailed);
	expect(() => first.getText('body')).toThrow(/owner worker is closed/);
	expect(() => second.getText('body')).toThrow(/owner worker is closed/);
	await first[Symbol.asyncDispose]();
	await expect(second[Symbol.asyncDispose]()).rejects.toBe(appendFailed);
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

function stateFor(value: string): Uint8Array {
	const remote = new Y.Doc({ gc: true });
	remote.get('body').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(remote));
	remote.destroy();
	return update;
}

function pullSetup({
	answer,
	onInstall,
}: {
	answer(request: {
		knownDocumentVersion: string | null;
	}): Awaited<ReturnType<DocumentPuller>> | Promise<never>;
	onInstall?(): Promise<void>;
}) {
	const appends: Uint8Array[] = [];
	const installs: Uint8Array[] = [];
	const pulls: (string | null)[] = [];
	const registry = createBrowserRowDocumentRegistry({
		async request<TResult>(operation: BrowserReplicaOwnerRuntimeOperation) {
			switch (operation.kind) {
				case 'open-runtime-document':
					return { kind: 'ready' } as TResult;
				case 'append-local-document':
					appends.push(new Uint8Array(operation.update));
					return undefined as TResult;
				case 'install-accepted-document':
					await onInstall?.();
					installs.push(new Uint8Array(operation.update));
					return undefined as TResult;
				default:
					throw new Error(`Unexpected operation '${operation.kind}'`);
			}
		},
		async pullFrom(pulledAddress, request) {
			expect(pulledAddress).toEqual(address);
			pulls.push(request.knownDocumentVersion);
			return await answer(request);
		},
	});
	return { registry, appends, installs, pulls };
}

test('pull installs through the owner before going live and creates no local work', async () => {
	const fixture = pullSetup({
		answer: () => ({
			kind: 'state',
			documentVersion: 'v1',
			update: stateFor('remote'),
		}),
	});
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	const { error } = await document.pull();
	expect(error).toBeNull();
	expect(fixture.installs).toHaveLength(1);
	expect(document.getText('body').toString()).toBe('remote');
	// The accepted origin keeps installed bytes out of the local persist path,
	// so nothing became newly owed work.
	expect(fixture.appends).toHaveLength(0);

	await document[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('a second pull carries the installed version and installs nothing when unchanged', async () => {
	const fixture = pullSetup({
		answer: ({ knownDocumentVersion }) =>
			knownDocumentVersion === 'v1'
				? { kind: 'unchanged', documentVersion: 'v1' }
				: { kind: 'state', documentVersion: 'v1', update: stateFor('remote') },
	});
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	expect((await document.pull()).error).toBeNull();
	expect((await document.pull()).error).toBeNull();
	expect(fixture.pulls).toEqual([null, 'v1']);
	expect(fixture.installs).toHaveLength(1);

	await document[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('a failed pull leaves the document open and usable', async () => {
	const fixture = pullSetup({
		answer: () => Promise.reject(new Error('offline')),
	});
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	const { error } = await document.pull();
	expect(error).toMatchObject({ name: 'DocumentPullFailed' });
	document.getText('body').insert(0, 'still editable');
	expect(document.getText('body').toString()).toBe('still editable');

	await document[Symbol.asyncDispose]();
	await fixture.registry.dispose();
});

test('a pull answered after revocation cannot install', async () => {
	let revoke: (() => void) | undefined;
	const fixture = pullSetup({
		answer: () => {
			revoke?.();
			return {
				kind: 'state',
				documentVersion: 'v1',
				update: stateFor('too late'),
			};
		},
	});
	revoke = () => fixture.registry.revokeAll();
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	const { error } = await document.pull();
	expect(error).toMatchObject({ name: 'RevokedDocument' });
	expect(fixture.installs).toHaveLength(0);
	await fixture.registry.dispose();
});

test('a pull whose durable install races revocation cannot go live', async () => {
	let revoke: (() => void) | undefined;
	const fixture = pullSetup({
		answer: () => ({
			kind: 'state',
			documentVersion: 'v1',
			update: stateFor('too late'),
		}),
		async onInstall() {
			revoke?.();
		},
	});
	revoke = () => fixture.registry.revokeAll();
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');

	const { error } = await document.pull();
	expect(error).toMatchObject({ name: 'RevokedDocument' });
	// The owner still committed the bytes; only the page mirror is fenced.
	expect(fixture.installs).toHaveLength(1);
	await fixture.registry.dispose();
});

test('a runtime with no authority declines to pull', async () => {
	const registry = createBrowserRowDocumentRegistry({
		async request<TResult>(operation: BrowserReplicaOwnerRuntimeOperation) {
			if (operation.kind === 'open-runtime-document') {
				return { kind: 'ready' } as TResult;
			}
			throw new Error(`Unexpected operation '${operation.kind}'`);
		},
	});
	const document = await registry.open(address);
	if (document === null) throw new Error('document did not open');

	expect((await document.pull()).error).toMatchObject({
		name: 'DocumentPullUnavailable',
	});
	await document[Symbol.asyncDispose]();
	await registry.dispose();
});

test('pull after handle disposal cannot mutate the handle', async () => {
	const fixture = pullSetup({
		answer: () => ({
			kind: 'state',
			documentVersion: 'v1',
			update: stateFor('remote'),
		}),
	});
	const document = await fixture.registry.open(address);
	if (document === null) throw new Error('document did not open');
	await document[Symbol.asyncDispose]();

	expect((await document.pull()).error).toMatchObject({
		name: 'RevokedDocument',
	});
	expect(fixture.installs).toHaveLength(0);
	await fixture.registry.dispose();
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

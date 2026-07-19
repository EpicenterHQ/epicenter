/**
 * Shared Persistence Attachment Tests
 *
 * Verifies the one renderer-side attachment implementation over a controlled
 * asynchronous load/append seam: listener-before-hydration, private replay
 * origin, invocation-time durability cuts, sequential appends with fail-stop,
 * byte-copy across the seam, and drain-on-dispose.
 */

import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	createDocumentStore,
	type DocumentPersistence,
	type RowAddress,
} from './persistence.js';

const note = { table: 'notes', rowId: 'a' } satisfies RowAddress;

function encodeText(root: string, text: string): Uint8Array {
	const document = new Y.Doc();
	try {
		document.get(root).insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function setup({
	stored = [],
	appendError,
}: {
	stored?: Uint8Array[];
	appendError?: () => Error | undefined;
} = {}) {
	const appended: { address: RowAddress; update: Uint8Array }[] = [];
	let releaseLoad: (() => void) | undefined;
	const persistence: DocumentPersistence = {
		async load(address) {
			if (releaseLoad !== undefined) {
				await new Promise<void>((resolve) => {
					releaseLoad = resolve;
				});
			}
			void address;
			return stored;
		},
		async append(address, update) {
			const failure = appendError?.();
			if (failure) throw failure;
			appended.push({ address, update });
		},
	};
	return {
		appended,
		store: createDocumentStore(persistence),
		holdLoad() {
			releaseLoad = () => undefined;
			return () => releaseLoad?.();
		},
	};
}

test('an edit racing hydration is captured and appended after load', async () => {
	const fixture = setup({ stored: [encodeText('persisted', 'stored')] });
	const release = fixture.holdLoad();
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		// The listener is attached before hydration resolves; this edit lands
		// while load is still pending.
		document.get('immediate').insert(0, 'local');
		expect(fixture.appended).toHaveLength(0);
		release();
		await lease.whenLoaded;
		expect(document.get('persisted').toString()).toBe('stored');
		await lease.whenDurable();
		expect(fixture.appended).toHaveLength(1);
		await lease.dispose();
	} finally {
		document.destroy();
	}
});

test('hydration replays with a private origin and is never re-appended', async () => {
	const fixture = setup({ stored: [encodeText('persisted', 'stored')] });
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await lease.whenLoaded;
		await lease.whenDurable();
		expect(fixture.appended).toHaveLength(0);
		await lease.dispose();
	} finally {
		document.destroy();
	}
});

test('whenDurable captures one invocation-time cut', async () => {
	const fixture = setup();
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'a');
		const firstCut = lease.whenDurable();
		document.get('editor').insert(1, 'b');
		expect(lease.whenDurable()).not.toBe(firstCut);
		await firstCut;
		await lease.whenDurable();
		expect(fixture.appended).toHaveLength(2);
		await lease.dispose();
	} finally {
		document.destroy();
	}
});

test('update bytes are copied before crossing the asynchronous seam', async () => {
	const fixture = setup();
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await lease.whenLoaded;
		let observed: Uint8Array | undefined;
		document.on('updateV2', (update: Uint8Array) => {
			observed = update;
		});
		document.get('editor').insert(0, 'shared');
		await lease.whenDurable();
		expect(observed).toBeDefined();
		// The appended buffer is an independent copy: zeroing the emitted view
		// cannot corrupt what the owner receives.
		observed!.fill(0);
		const replayed = new Y.Doc();
		try {
			Y.applyUpdateV2(replayed, fixture.appended[0]!.update);
			expect(replayed.get('editor').toString()).toBe('shared');
		} finally {
			replayed.destroy();
		}
		await lease.dispose();
	} finally {
		document.destroy();
	}
});

test('a failed append stops the chain so no successor commits over a gap', async () => {
	let failures = 0;
	const fixture = setup({
		appendError: () => {
			failures += 1;
			return failures === 1 ? new Error('owner refused this append') : undefined;
		},
	});
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'first');
		document.get('editor').insert(5, 'second');
		await expect(lease.whenDurable()).rejects.toThrow(
			'owner refused this append',
		);
		// The second update was skipped, not appended in front of a gap.
		expect(fixture.appended).toHaveLength(0);
		expect(failures).toBe(1);
		await expect(lease.dispose()).rejects.toThrow('owner refused this append');
	} finally {
		document.destroy();
	}
});

test('a lease failure stays scoped to its own address', async () => {
	let refuseNoteAppends = false;
	const appended: RowAddress[] = [];
	const store = createDocumentStore({
		async load() {
			return [];
		},
		async append(address) {
			if (refuseNoteAppends && address.rowId === 'a') {
				throw new Error('row a is gone');
			}
			appended.push(address);
		},
	});
	const doomed = new Y.Doc();
	const healthy = new Y.Doc();
	try {
		const doomedLease = store.attach(note, doomed);
		const healthyLease = store.attach({ table: 'notes', rowId: 'b' }, healthy);
		await Promise.all([doomedLease.whenLoaded, healthyLease.whenLoaded]);
		refuseNoteAppends = true;
		doomed.get('editor').insert(0, 'lost');
		healthy.get('editor').insert(0, 'kept');
		await expect(doomedLease.whenDurable()).rejects.toThrow('row a is gone');
		await healthyLease.whenDurable();
		expect(appended).toEqual([{ table: 'notes', rowId: 'b' }]);
		await healthyLease.dispose();
		await doomedLease.dispose().catch(() => undefined);
	} finally {
		doomed.destroy();
		healthy.destroy();
	}
});

test('dispose stops the listener and drains admitted appends', async () => {
	const fixture = setup();
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'durable');
		await lease.dispose();
		document.get('editor').insert(7, ' ignored');
		await Promise.resolve();
		expect(fixture.appended).toHaveLength(1);
	} finally {
		document.destroy();
	}
});

test('one address admits one attachment at a time', async () => {
	const fixture = setup();
	const document = new Y.Doc();
	const second = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		expect(() => fixture.store.attach({ ...note }, second)).toThrow(
			'already attached',
		);
		await lease.dispose();
		const reattached = fixture.store.attach(note, second);
		await reattached.whenLoaded;
		await reattached.dispose();
	} finally {
		document.destroy();
		second.destroy();
	}
});

test('corrupt stored updates reject hydration', async () => {
	const fixture = setup({ stored: [new Uint8Array([255])] });
	const document = new Y.Doc();
	try {
		const lease = fixture.store.attach(note, document);
		await expect(lease.whenLoaded).rejects.toThrow();
		await expect(lease.whenDurable()).rejects.toThrow();
		await lease.dispose().catch(() => undefined);
	} finally {
		document.destroy();
	}
});

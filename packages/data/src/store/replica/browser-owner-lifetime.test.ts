/**
 * Browser Replica Owner Lifetime Tests
 *
 * Verifies that loss of the origin Web Lock is a terminal SQLite-owner
 * transition rather than a recoverable coordination event.
 *
 * Key behaviors:
 * - owner loss synchronously closes SQLite and pauses the SAH-pool
 * - operations fail with the stable owner-lost error after loss
 * - disposal releases the lease once without reviving the owner
 */
import { expect, test } from 'bun:test';

import { createBrowserReplicaOwnerLifetime } from './browser-owner-lifetime.js';

function setup({ activate = true }: { activate?: boolean } = {}) {
	const events: string[] = [];
	let isDatabaseOpen = true;
	let isVfsPaused = false;
	let isLeaseReleased = false;
	const lifetime = createBrowserReplicaOwnerLifetime({
		closeDatabase() {
			if (!isDatabaseOpen) return;
			isDatabaseOpen = false;
			events.push('database-closed');
		},
		pauseVfs() {
			if (isVfsPaused) return;
			isVfsPaused = true;
			events.push('vfs-paused');
		},
		async releaseLease() {
			if (isLeaseReleased) return;
			isLeaseReleased = true;
			events.push('lease-released');
		},
	});
	if (activate) lifetime.activate();
	return {
		events,
		lifetime,
		enterReplacementOwner() {
			if (isDatabaseOpen || !isVfsPaused) {
				throw new Error('Previous physical owner is still active');
			}
			events.push('replacement-entered');
		},
	};
}

test('owner loss closes SQLite and pauses the VFS before returning', () => {
	const { events, lifetime } = setup();

	lifetime.ownerLost();

	expect(events).toEqual(['database-closed', 'vfs-paused']);
	expect(() => lifetime.requireActive()).toThrow(
		'Browser replica storage moved to a newer owner',
	);
	try {
		lifetime.requireActive();
	} catch (cause) {
		expect(cause).toMatchObject({ name: 'EpicenterBrowserOwnerLostError' });
	}
});

test('replacement physical storage stays blocked until loss cleanup pauses the VFS', () => {
	const { enterReplacementOwner, events, lifetime } = setup();

	expect(enterReplacementOwner).toThrow(
		'Previous physical owner is still active',
	);
	lifetime.ownerLost();
	enterReplacementOwner();

	expect(events).toEqual([
		'database-closed',
		'vfs-paused',
		'replacement-entered',
	]);
	expect(() => lifetime.requireActive()).toThrow(
		'Browser replica storage moved to a newer owner',
	);
});

test('disposal releases a lost lease once and preserves terminal loss', async () => {
	const { events, lifetime } = setup();
	lifetime.ownerLost();

	await lifetime.dispose();
	await lifetime.dispose();

	expect(events).toEqual(['database-closed', 'vfs-paused', 'lease-released']);
	expect(() => lifetime.requireActive()).toThrow(
		'Browser replica storage moved to a newer owner',
	);
});

test('loss during opening prevents activation and retains the loss error', async () => {
	const { events, lifetime } = setup({ activate: false });

	lifetime.ownerLost();
	expect(() => lifetime.activate()).toThrow(
		'Browser replica storage moved to a newer owner',
	);
	await lifetime.dispose();

	expect(events.at(-1)).toBe('lease-released');
	expect(() => lifetime.requireActive()).toThrow(
		'Browser replica storage moved to a newer owner',
	);
});

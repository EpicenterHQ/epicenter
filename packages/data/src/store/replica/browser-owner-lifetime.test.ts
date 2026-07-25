/**
 * Browser Replica Owner Lifetime Tests
 *
 * Verifies that disposal is the one ordered transition between the origin Web
 * Lock and the SQLite resources it admits.
 *
 * Key behaviors:
 * - disposal closes SQLite and pauses the SAH-pool before releasing the lease
 * - a successor cannot open physical storage until that cleanup has landed
 * - disposal is idempotent and never revives the owner
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
		enterSuccessorOwner() {
			if (isDatabaseOpen || !isVfsPaused) {
				throw new Error('Previous physical owner is still active');
			}
			events.push('successor-entered');
		},
	};
}

test('disposal closes SQLite and pauses the VFS before releasing the lease', async () => {
	const { events, lifetime } = setup();

	await lifetime.dispose();

	expect(events).toEqual(['database-closed', 'vfs-paused', 'lease-released']);
	expect(() => lifetime.requireActive()).toThrow(
		'browser replica owner is disposed',
	);
});

test('a successor cannot open physical storage until cleanup pauses the VFS', async () => {
	const { enterSuccessorOwner, events, lifetime } = setup();

	expect(enterSuccessorOwner).toThrow(
		'Previous physical owner is still active',
	);
	await lifetime.dispose();
	enterSuccessorOwner();

	expect(events).toEqual([
		'database-closed',
		'vfs-paused',
		'lease-released',
		'successor-entered',
	]);
});

test('disposal releases the lease once and stays terminal', async () => {
	const { events, lifetime } = setup();

	await lifetime.dispose();
	await lifetime.dispose();

	expect(events).toEqual(['database-closed', 'vfs-paused', 'lease-released']);
	expect(() => lifetime.activate()).toThrow(
		"browser replica owner cannot open from state 'disposed'",
	);
});

test('disposal during opening prevents later activation', async () => {
	const { events, lifetime } = setup({ activate: false });

	await lifetime.dispose();

	expect(() => lifetime.activate()).toThrow(
		"browser replica owner cannot open from state 'disposed'",
	);
	expect(events.at(-1)).toBe('lease-released');
});

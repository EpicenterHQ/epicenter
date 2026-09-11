/**
 * The durable restore attempt: one unresolved slot, a request that survives
 * reopening, and a fence that stops a late activation from a finalized failure.
 * The authority stays byte-opaque here; codec composition lives in recovery.test.ts.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCurrentAuthority } from './authority.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const identity = {
	appId: 'so.epicenter.notes',
	dataId: 'so.epicenter.notes',
};
const library = `libraries/apps/${identity.appId}/personal/alice/data/${identity.dataId}`;

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'restore-attempts-'));
	directories.push(directory);
	const path = join(directory, 'authority.sqlite');
	const database = new Database(path);
	const authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	authority.ensureCurrent(new Uint8Array([1]));
	const attempts = authority.attempts({ library, identity });
	const request = {
		operation: generateBlobId(),
		backupId: generateBlobId(),
		backupDigest: 'a'.repeat(64),
	};
	/** Reopen the same file, the way a new process would. */
	function reopen() {
		const reopened = new Database(path);
		const owner = openCurrentAuthority({
			sqlite: createBunSqliteAdapter(reopened),
		});
		return {
			authority: owner,
			attempts: owner.attempts({ library, identity }),
			close: () => reopened.close(),
		};
	}
	return {
		directory,
		authority,
		attempts,
		request,
		reopen,
		[Symbol.dispose]() {
			database.close();
		},
	};
}

test('one library holds one unresolved attempt, and reserving it again resumes the same request', async () => {
	using s = await setup();
	const reserved = expectOk(s.attempts.reserve(s.request));
	expect(reserved).toMatchObject({
		operation: s.request.operation,
		library,
		status: 'pending',
		safetyBackupId: undefined,
		destination: undefined,
		activationDigest: undefined,
	});
	expect(expectOk(s.attempts.reserve(s.request))).toEqual(reserved);
	const other = expectErr(
		s.attempts.reserve({
			operation: generateBlobId(),
			backupId: generateBlobId(),
			backupDigest: 'b'.repeat(64),
		}),
	);
	expect(other).toMatchObject({
		name: 'AttemptPending',
		operation: s.request.operation,
	});
	// Reusing the identity for a different selection is a conflict, not a resume.
	expect(
		expectErr(s.attempts.reserve({ ...s.request, backupId: generateBlobId() }))
			.name,
	).toBe('AttemptConflict');
	expect(expectOk(s.attempts.pending())).toEqual(reserved);
});

test('the safety backup and prepared request are pinned once and survive reopening', async () => {
	using s = await setup();
	expectOk(s.attempts.reserve(s.request));
	const safetyBackupId = generateBlobId();
	expect(
		expectOk(
			s.attempts.associateSafetyBackup(s.request.operation, safetyBackupId),
		).safetyBackupId,
	).toBe(safetyBackupId);
	// Set once: a repeat is idempotent and a different id is refused.
	expectOk(
		s.attempts.associateSafetyBackup(s.request.operation, safetyBackupId),
	);
	expect(
		expectErr(
			s.attempts.associateSafetyBackup(s.request.operation, generateBlobId()),
		).name,
	).toBe('AttemptConflict');
	const preparation = {
		destination: { generation: 1, head: 4 },
		activationDigest: 'c'.repeat(64),
		activationObjectId: generateBlobId(),
	};
	expectOk(s.attempts.pinPreparation(s.request.operation, preparation));
	expectOk(s.attempts.pinPreparation(s.request.operation, preparation));
	expect(
		expectErr(
			s.attempts.pinPreparation(s.request.operation, {
				...preparation,
				activationDigest: 'd'.repeat(64),
			}),
		).name,
	).toBe('AttemptConflict');
	const reopened = s.reopen();
	try {
		expect(expectOk(reopened.attempts.pending())).toMatchObject({
			operation: s.request.operation,
			safetyBackupId,
			destination: preparation.destination,
			activationDigest: preparation.activationDigest,
			activationObjectId: preparation.activationObjectId,
		});
	} finally {
		reopened.close();
	}
});

test('a finalized failure releases the slot and fences that attempt from activating later', async () => {
	using s = await setup();
	expectOk(s.attempts.reserve(s.request));
	const bytes = new Uint8Array([9, 9, 9]);
	// Prepared before the failure, exactly like a request already in flight.
	const inFlight = await s.authority.prepareActivation({
		operation: s.request.operation,
		expected: { generation: 1, head: 1 },
		bytes,
	});
	expect(expectOk(s.attempts.fail(s.request.operation)).status).toBe('failed');
	expect(inFlight.activate()).toEqual({ status: 'fenced' });
	expect(s.authority.receipt(s.request.operation)).toBeUndefined();
	expect(s.authority.capture().generation).toBe(1);
	// The slot is free, and a later deliberate attempt for the same backup is new.
	expect(expectOk(s.attempts.pending())).toBeUndefined();
	const next = { ...s.request, operation: generateBlobId() };
	expect(expectOk(s.attempts.reserve(next)).operation).toBe(next.operation);
	// The fence is durable, not a property of the lifetime that wrote it.
	const reopened = s.reopen();
	try {
		expect(
			(
				await reopened.authority.prepareActivation({
					operation: s.request.operation,
					expected: { generation: 1, head: 1 },
					bytes,
				})
			).activate(),
		).toEqual({ status: 'fenced' });
	} finally {
		reopened.close();
	}
});

test('activation resolves its attempt, and the receipt is readable without the bytes', async () => {
	using s = await setup();
	expectOk(s.attempts.reserve(s.request));
	const destination = { generation: 1, head: 1 };
	const bytes = new Uint8Array([4, 5, 6]);
	const digest = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	expectOk(
		s.attempts.pinPreparation(s.request.operation, {
			destination,
			activationDigest: digest,
			activationObjectId: generateBlobId(),
		}),
	);
	// Bytes that were never pinned cannot activate under this attempt's identity.
	expect(
		(
			await s.authority.prepareActivation({
				operation: s.request.operation,
				expected: destination,
				bytes: new Uint8Array([7]),
			})
		).activate(),
	).toEqual({ status: 'operation-conflict' });
	const receipt = (
		await s.authority.prepareActivation({
			operation: s.request.operation,
			expected: destination,
			bytes,
		})
	).activate();
	const committed = {
		status: 'activated',
		operation: s.request.operation,
		generation: 2,
		head: 1,
	} as const;
	expect(receipt).toEqual(committed);
	expect(expectOk(s.attempts.get(s.request.operation))?.status).toBe(
		'activated',
	);
	expect(expectOk(s.attempts.pending())).toBeUndefined();
	// A committed outcome cannot be rewritten into a failure.
	expect(expectErr(s.attempts.fail(s.request.operation)).name).toBe(
		'AttemptResolved',
	);
	const reopened = s.reopen();
	try {
		// The whole point of the query: no archive, no prepared object, no bytes.
		expect(reopened.authority.receipt(s.request.operation)).toEqual(committed);
		expect(reopened.authority.receipt(generateBlobId())).toBeUndefined();
	} finally {
		reopened.close();
	}
});

test('an attempt journal refuses to open against another library', async () => {
	using s = await setup();
	expect(() =>
		s.authority.attempts({ library: `${library}/other`, identity }),
	).toThrow('another library');
	expect(() =>
		s.authority.attempts({
			library,
			identity: { ...identity, appId: 'so.other.app' },
		}),
	).toThrow('another library');
});

test('reserving a resolved attempt reports its outcome instead of handing back the slot', async () => {
	using s = await setup();
	expectOk(s.attempts.reserve(s.request));
	expectOk(s.attempts.fail(s.request.operation));
	const refused = expectErr(s.attempts.reserve(s.request));
	expect(refused).toMatchObject({ name: 'AttemptResolved', status: 'failed' });
	// The slot itself is free, so a new attempt for the same backup can start.
	expect(
		expectOk(
			s.attempts.reserve({ ...s.request, operation: generateBlobId() }),
		).status,
	).toBe('pending');
});

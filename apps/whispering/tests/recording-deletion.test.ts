/**
 * Recording Deletion Tests
 *
 * Verifies that the shared cleanup operation treats local blob deletion
 * as the commit gate for removing synced recording rows.
 *
 * Key behaviors:
 * - Remote purge completes before local bytes and rows are deleted
 * - Mixed deletion preflights remote capability before mutating local-only rows
 * - Each workspace row is deleted before the next recording begins
 * - A later failure reports the already-completed prefix
 */
import { expect, mock, test } from 'bun:test';
import { BlobStoreError, generateBlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/field';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { RecordingId } from '../src/lib/workspace';

mock.module('@epicenter/ui/confirmation-dialog', () => ({
	confirmationDialog: { open: mock() },
}));

mock.module('$lib/report', () => ({
	log: { warn: mock() },
	report: { error: mock(), success: mock() },
}));

mock.module('$lib/services', () => ({
	services: {
		blobs: { local: { delete: mock() }, remote: null },
	},
}));

const { deleteRecordings } = await import('../src/lib/operations/recordings');
type WhisperingApp =
	import('../src/lib/whispering/application').WhisperingApplication;

// The explicit dependencies below own every effect; the app is never touched.
const app = { recordings: { delete: mock() } } as unknown as WhisperingApp;

const recording = {
	id: 'recording-1' as RecordingId,
	audioBlobId: generateBlobId(),
	uploadedAt: null,
};

test('blob deletion completes before its synced row is deleted', async () => {
	const events: string[] = [];

	const result = await deleteRecordings(app, recording, {
		canPurgeRemote: () => false,
		local: {
			async delete(id) {
				events.push(`blob:${id}`);
				return Ok(undefined);
			},
		},
		purgeRemote: async () => Ok(undefined),
		async deleteRow(id) {
			events.push(`row:${id}`);
		},
	});

	expectOk(result);
	expect(events).toEqual([`blob:${recording.audioBlobId}`, 'row:recording-1']);
});

test('blob deletion failure preserves synced recording rows', async () => {
	const rowDeletes: RecordingId[] = [];

	const result = await deleteRecordings(app, recording, {
		canPurgeRemote: () => false,
		local: {
			async delete() {
				return BlobStoreError.BlobStoreFailed({
					id: recording.audioBlobId,
					cause: new Error('disk busy'),
				});
			},
		},
		purgeRemote: async () => Ok(undefined),
		async deleteRow(id) {
			rowDeletes.push(id);
		},
	});

	const error = expectErr(result);
	expect(error.name).toBe('DeletionFailed');
	if (error.name !== 'DeletionFailed')
		throw new Error('expected deletion error');
	expect(error.stage).toBe('device-copy');
	expect(error.deletedRecordingIds).toEqual([]);
	expect(rowDeletes).toEqual([]);
});

test('uploaded audio is purged and unmarked before local bytes and rows are deleted', async () => {
	const events: string[] = [];
	const uploaded = { ...recording, uploadedAt: InstantString.now() };

	expectOk(
		await deleteRecordings(app, uploaded, {
			canPurgeRemote: () => true,
			async purgeRemote() {
				events.push('remote');
				return Ok(undefined);
			},
			local: {
				async delete() {
					events.push('local');
					return Ok(undefined);
				},
			},
			async deleteRow() {
				events.push('row');
			},
		}),
	);

	expect(events).toEqual(['remote', 'local', 'row']);
});

test('a later failure reports the recordings already deleted', async () => {
	const second = {
		...recording,
		id: 'recording-2' as RecordingId,
		audioBlobId: generateBlobId(),
	};
	const events: string[] = [];

	const error = expectErr(
		await deleteRecordings(app, [recording, second], {
			canPurgeRemote: () => true,
			purgeRemote: async () => Ok(undefined),
			local: {
				async delete(id) {
					events.push(`blob:${id}`);
					return id === second.audioBlobId
						? BlobStoreError.BlobStoreFailed({
								id,
								cause: new Error('disk busy'),
							})
						: Ok(undefined);
				},
			},
			async deleteRow(id) {
				events.push(`row:${id}`);
			},
		}),
	);

	expect(error.name).toBe('DeletionFailed');
	if (error.name !== 'DeletionFailed')
		throw new Error('expected deletion error');
	expect(error.deletedRecordingIds).toEqual([recording.id]);
	expect(error.recordingId).toBe(second.id);
	expect(events).toEqual([
		`blob:${recording.audioBlobId}`,
		`row:${recording.id}`,
		`blob:${second.audioBlobId}`,
	]);
});

test('mixed deletion without a remote leaves every selected recording untouched', async () => {
	const events: string[] = [];
	const uploaded = {
		...recording,
		id: 'recording-2' as RecordingId,
		uploadedAt: InstantString.now(),
	};

	const error = expectErr(
		await deleteRecordings(app, [recording, uploaded], {
			canPurgeRemote: () => false,
			async purgeRemote() {
				events.push('remote');
				return Ok(undefined);
			},
			local: {
				async delete() {
					events.push('local');
					return Ok(undefined);
				},
			},
			async deleteRow() {
				events.push('row');
			},
		}),
	);

	expect(error.name).toBe('RemoteUnavailable');
	expect(events).toEqual([]);
});

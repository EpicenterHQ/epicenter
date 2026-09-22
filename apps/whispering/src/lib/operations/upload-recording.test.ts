/** Explicit upload references the saved object and changes the row only on success. */
import { expect, mock, test } from 'bun:test';
import { generateBlobId, RemoteBlobsError } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { WhisperingApp } from '$lib/whispering/app';
import { type Recording, whisperingDefinition } from '../data.js';

const remoteId = generateBlobId('wav');
const reference = {
	blobId: remoteId,
	authorityId: 'server',
	principalId: 'alice',
	namespace: whisperingDefinition.id,
};

import { uploadRecording } from './upload-recording.js';

function setup() {
	const recording = {
		id: 'recording',
		audioBlobId: generateBlobId('wav'),
	} as Recording;
	const upload = mock(async () => Ok(remoteId));
	const get = mock();
	const patch = mock(() => Ok(undefined));
	const lifetime = new AbortController();
	const app = {
		signal: lifetime.signal,
		localBlobs: { get },
		remoteBlobs: { copyFrom: upload },
		personal: { identity: { authorityId: 'server', principalId: 'alice' } },
		library: {
			tables: { recordings: { update: patch, get: () => recording } },
		},
	} as unknown as WhisperingApp;
	return { recording, app, upload, get, patch, lifetime };
}

test('upload sends a local ID and retains the returned scoped remote reference', async () => {
	const f = setup();
	const cancellation = new AbortController();
	expect(
		expectOk(await uploadRecording(f.app, f.recording, cancellation.signal)),
	).toEqual(reference);
	expect(f.upload).toHaveBeenCalledWith(
		f.app.localBlobs,
		f.recording.audioBlobId,
		{
			signal: cancellation.signal,
		},
	);
	expect(f.get).not.toHaveBeenCalled();
	expect(f.patch).toHaveBeenCalledWith(f.recording.id, {
		remoteAudio: reference,
	});
});

test('a refused upload preserves the row reference', async () => {
	const f = setup();
	const remote = {
		copyFrom: async () => RemoteBlobsError.TooLarge({ size: 100_000_000 }),
	};
	Object.assign(f.app, { remoteBlobs: remote });
	expect(
		expectErr(
			await uploadRecording(f.app, f.recording, new AbortController().signal),
		).name,
	).toBe('TooLarge');
	expect(f.patch).not.toHaveBeenCalled();
});

test('Account retirement suppresses a late row write without deleting the remote result', async () => {
	const f = setup();
	f.upload.mockImplementation(async () => {
		f.lifetime.abort();
		return Ok(remoteId);
	});
	const error = expectErr(
		await uploadRecording(f.app, f.recording, new AbortController().signal),
	);
	expect(error).toMatchObject({
		name: 'ReferenceNotSaved',
		reference,
	});
	expect(f.patch).not.toHaveBeenCalled();
});

test('a failed row update returns the uploaded reference for recovery', async () => {
	const f = setup();
	f.patch.mockImplementation(() => {
		throw new Error('Storage unavailable');
	});
	const error = expectErr(
		await uploadRecording(f.app, f.recording, new AbortController().signal),
	);
	expect(error).toMatchObject({
		name: 'ReferenceNotSaved',
		reference,
	});
	expect(f.upload).toHaveBeenCalledTimes(1);
});

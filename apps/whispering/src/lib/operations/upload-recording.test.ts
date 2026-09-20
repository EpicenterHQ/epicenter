/** Explicit upload references the saved object and changes the row only on success. */
import { expect, mock, test } from 'bun:test';
import { generateBlobId, RemoteBlobsError } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../data.js';
import { uploadRecording } from './upload-recording';

function setup() {
	const recording = {
		id: 'recording',
		audioBlobId: generateBlobId('wav'),
	} as Recording;
	const addLocal = mock(async () => Ok('https://cloud.example/saved'));
	const get = mock();
	const patch = mock(() => Ok(undefined));
	const lifetime = new AbortController();
	const app = {
		signal: lifetime.signal,
		blobs: { local: { get }, remote: { addLocal } },
		library: {
			tables: { recordings: { update: patch, get: () => recording } },
		},
	} as unknown as WhisperingApp;
	return { recording, app, addLocal, get, patch, lifetime };
}

test('upload sends a local ID and retains the returned remote URL', async () => {
	const f = setup();
	const cancellation = new AbortController();
	expect(
		expectOk(await uploadRecording(f.app, f.recording, cancellation.signal)),
	).toBe('https://cloud.example/saved');
	expect(f.addLocal).toHaveBeenCalledWith(f.recording.audioBlobId, {
		signal: cancellation.signal,
	});
	expect(f.get).not.toHaveBeenCalled();
	expect(f.patch).toHaveBeenCalledWith(f.recording.id, {
		audioUrl: 'https://cloud.example/saved',
	});
});

test('a refused upload preserves the row reference', async () => {
	const f = setup();
	const remote = {
		addLocal: async () => RemoteBlobsError.TooLarge({ size: 100_000_000 }),
	};
	Object.assign(f.app.blobs, { remote });
	expect(
		expectErr(
			await uploadRecording(f.app, f.recording, new AbortController().signal),
		).name,
	).toBe('TooLarge');
	expect(f.patch).not.toHaveBeenCalled();
});

test('Account retirement suppresses a late row write without deleting the remote result', async () => {
	const f = setup();
	f.addLocal.mockImplementation(async () => {
		f.lifetime.abort();
		return Ok('https://cloud.example/saved');
	});
	expectErr(
		await uploadRecording(f.app, f.recording, new AbortController().signal),
	);
	expect(f.patch).not.toHaveBeenCalled();
});

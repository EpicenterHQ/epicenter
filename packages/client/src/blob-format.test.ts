/**
 * File format evidence survives local publication and explicit upload.
 * Real local publication is compared with captured account requests; private URL
 * ownership and copy identity are preserved.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createLocalBlobAccess } from '@epicenter/blobs/owner';
import { expectOk } from 'wellcrafted/testing';
import { createRemoteBlobClient } from './index.js';

test.each([
	['take.WAV', '', 'audio/wav'],
	['take.M4A', 'application/octet-stream', 'audio/mp4'],
	['take.WEBM', 'binary/octet-stream', 'video/webm'],
	['take.OPUS', '', 'audio/ogg'],
	['misleading.mp3', 'audio/x-wav', 'audio/wav'],
	['misleading.mp3', 'audio/webm;codecs=opus', 'video/webm'],
	['misleading.wav', 'application/x-unknown', 'application/octet-stream'],
	['unknown.data', '', 'application/octet-stream'],
])('saved %s (%s) uploads its bytes as %s', async (name, type, expectedType) => {
	const directory = await mkdtemp(join(tmpdir(), 'blob-upload-format-'));
	const local = createBunBlobStore({ directory });
	const owner = createLocalBlobAccess({
		local,
		sources: createBrowserBlobSources(local),
	});
	const requests: Request[] = [];
	const appId = 'so.epicenter.format.test';
	const baseURL = 'https://api.example.test';
	const account = {
		baseURL,
		principalId: 'alice',
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return Response.json({ id: generateBlobId('bin') }, { status: 201 });
		},
	} as Account;
	const remote = createRemoteBlobClient({ appId, account });
	try {
		const file = new File(['identical bytes'], name, { type });
		const id = expectOk(await owner.value.add(file));
		expectOk(await remote.copyFromLocal({ local }, id));
		expect(requests[0]!.url).toEndWith('/principals/alice/blobs');
		expect(requests).toHaveLength(1);
		for (const request of requests) {
			expect(request.headers.get('content-type')).toBe(expectedType);
			expect(request.redirect).toBe('error');
			expect(await request.text()).toBe('identical bytes');
		}
		expect(await expectOk(await local.get(id)).text()).toBe('identical bytes');
	} finally {
		await owner.close();
		await rm(directory, { recursive: true, force: true });
	}
});

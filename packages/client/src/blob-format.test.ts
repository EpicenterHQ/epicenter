/**
 * File format evidence survives both direct and local-first explicit uploads.
 * Real local publication is compared with captured account requests; private URL
 * ownership and independently minted remote IDs remain unchanged.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@epicenter/auth';
import {
	generateBlobId,
	REMOTE_BLOB_ROUTES,
	selectBlobFormat,
} from '@epicenter/blobs';
import { createAppBlobs } from '@epicenter/blobs/app';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { expectOk } from 'wellcrafted/testing';
import { createRemoteBlobClient } from './index.js';

test.each([
	['take.WAV', '', 'audio/wav'],
	['take.M4A', 'application/octet-stream', 'audio/mp4'],
	['take.WEBM', 'binary/octet-stream', 'video/webm'],
	['take.OPUS', '', 'audio/ogg'],
	['misleading.mp3', 'audio/x-wav', 'audio/x-wav'],
	['misleading.mp3', 'audio/webm;codecs=opus', 'audio/webm;codecs=opus'],
	['misleading.wav', 'application/x-unknown', 'application/x-unknown'],
	['unknown.data', '', 'application/octet-stream'],
])('direct and local-first %s (%s) upload identical bytes as %s', async (name, type, expectedType) => {
	const directory = await mkdtemp(join(tmpdir(), 'blob-upload-format-'));
	const local = createBunBlobStore({ directory });
	const owner = createAppBlobs({
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
			return Response.json({
				url: REMOTE_BLOB_ROUTES.objectUrl(
					baseURL,
					appId,
					'alice',
					generateBlobId('bin'),
				),
			});
		},
	} as Account;
	const remote = createRemoteBlobClient({ appId, account, local });
	try {
		const file = new File(['identical bytes'], name, { type });
		const directUrl = expectOk(await remote.add(file));
		const id = expectOk(await owner.value.add(file));
		const savedUrl = expectOk(await remote.addLocal(id));
		expect(directUrl).not.toBe(savedUrl);
		expect(directUrl).not.toContain(id);
		expect(savedUrl).not.toContain(id);
		expect(requests).toHaveLength(2);
		for (const [index, request] of requests.entries()) {
			expect(request.headers.get('content-type')).toBe(
				index === 0 ? expectedType : selectBlobFormat(file).contentType,
			);
			expect(request.redirect).toBe('error');
			expect(await request.text()).toBe('identical bytes');
		}
		expect(await expectOk(await local.get(id)).text()).toBe('identical bytes');
	} finally {
		await owner.close();
		await rm(directory, { recursive: true, force: true });
	}
});

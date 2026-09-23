import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { mintPersonalBlobUrl } from '@epicenter/blobs';
import { createPersonalHostedBlobs } from './hosted-blobs.js';

const baseURL = 'https://api.test';

function account(fetch: Account['fetch']): Account {
	return {
		authorityId: 'test',
		principalId: 'alice' as Account['principalId'],
		baseURL,
		fetch,
		async getProfile() {
			throw new Error('Unused');
		},
		async openWebSocket() {
			throw new Error('Unused');
		},
	};
}

test('publication captures owner and visibility, then validates the returned URL', async () => {
	const requests: Request[] = [];
	const url = mintPersonalBlobUrl(baseURL, 'alice', 'private');
	const blobs = createPersonalHostedBlobs(
		account(async (input, init) => {
			requests.push(new Request(input, init));
			return Response.json({ url }, { status: 201 });
		}),
	);
	const result = await blobs.publishPrivate(new Blob(['audio'], { type: 'audio/webm' }));
	expect(result.error).toBeNull();
	expect(result.data).toBe(url);
	expect(requests[0]!.url).toBe(`${baseURL}/api/blobs/personal/alice/private`);
	expect(requests[0]!.method).toBe('POST');
	expect(await requests[0]!.text()).toBe('audio');
	const wrong = createPersonalHostedBlobs(
		account(async () =>
			Response.json(
				{ url: mintPersonalBlobUrl(baseURL, 'bob', 'private') },
				{ status: 201 },
			),
		),
	);
	expect((await wrong.publishPrivate(new Blob(['audio']))).error?.name).toBe(
		'PublicationUnconfirmed',
	);
});

test('download accepts a known URL and delete refuses a foreign owner', async () => {
	const url = mintPersonalBlobUrl(baseURL, 'alice', 'public');
	const requests: Request[] = [];
	const blobs = createPersonalHostedBlobs(
		account(async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(init?.method === 'DELETE' ? null : 'audio', {
				status: init?.method === 'DELETE' ? 204 : 200,
			});
		}),
	);
	expect((await blobs.download(url)).data).toBeInstanceOf(Blob);
	expect((await blobs.delete(url)).error).toBeNull();
	expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE']);
	expect(() => blobs.delete(mintPersonalBlobUrl(baseURL, 'bob', 'public'))).toThrow();
});

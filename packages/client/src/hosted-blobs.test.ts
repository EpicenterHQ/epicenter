/**
 * Account-bound hosted blob tests.
 *
 * Publication sends the captured owner and visibility, validates the returned
 * URL, and reports another owner's URL as unconfirmed. Downloads and deletion
 * use the same account while foreign-owner deletion is refused before fetch.
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { mintPersonalBlobUrl } from '@epicenter/blobs';
import { expectErr, expectOk } from 'wellcrafted/testing';
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
	const result = await blobs.publishPrivate(
		new Blob(['audio'], { type: 'audio/webm' }),
	);
	expect(expectOk(result)).toBe(url);
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
	const refused = await wrong.publishPrivate(new Blob(['audio']));
	expect(expectErr<NonNullable<typeof refused.error>>(refused).name).toBe(
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
	expect(expectOk(await blobs.download(url))).toBeInstanceOf(Blob);
	expectOk(await blobs.delete(url));
	expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE']);
	await expect(
		blobs.delete(mintPersonalBlobUrl(baseURL, 'bob', 'public')),
	).rejects.toThrow('another principal');
	expect(requests).toHaveLength(2);
});

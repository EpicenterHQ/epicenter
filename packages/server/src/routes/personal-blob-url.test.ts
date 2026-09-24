import { expect, test } from 'bun:test';
import { mintPersonalBlobUrl, parsePersonalBlobUrl } from '@epicenter/blobs';

const authority = 'https://api.test';
const valid = mintPersonalBlobUrl(authority, 'alice_1', 'public');

test('minted URLs parse to their canonical owner and storage key', () => {
	const address = parsePersonalBlobUrl(valid, authority);
	expect(address).toEqual({
		principalId: 'alice_1',
		visibility: 'public',
		key: valid.split('/').at(-1)!,
		storageKey: `personal/alice_1/public/${valid.split('/').at(-1)}`,
	});
	expect(address!.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
	expect(mintPersonalBlobUrl(authority, 'alice_1', 'public')).not.toBe(valid);
});

test.each([
	valid + '?download=1',
	valid + '#part',
	valid.replace('https://', 'http://'),
	valid.replace('api.test', 'other.test'),
	valid.replace('api.test', 'alice@api.test'),
	valid.replace('/alice_1/', '/%61lice_1/'),
	valid.replace('/public/', '/%70ublic/'),
	valid.replace('/public/', '/private/').replace(/[^/]+$/, 'short'),
	valid.replace('/personal/', '/spaces/'),
	valid.replace('/public/', '/public/../public/'),
	valid.replace('/alice_1/', '/alice%2Fbob/'),
])('parser refuses noncanonical address %s', (url) => {
	expect(parsePersonalBlobUrl(url, authority)).toBeUndefined();
});

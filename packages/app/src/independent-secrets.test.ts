/** A secret handle retires access without removing committed device credentials. */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { secretLabel } from '@epicenter/device';
import { openSecrets } from './secrets.js';

test('secret close is terminal and leaves other namespaces and committed values usable', async () => {
	const first = await openSecrets({ id: 'test.secrets' });
	const sibling = await openSecrets({ id: 'test.other-secrets' });
	expectOk(await first.put(secretLabel('token'), 'retained'));
	const close = first.close();
	expect(first.close()).toBe(close);
	expect(first.signal.aborted).toBe(true);
	expect(() => first.get(secretLabel('token'))).toThrow();
	await close;
	expectOk(await sibling.put(secretLabel('token'), 'other'));
	const reopened = await openSecrets({ id: 'test.secrets' });
	expect(expectOk(await reopened.get(secretLabel('token')))).toBe('retained');
	expect(expectOk(await sibling.get(secretLabel('token')))).toBe('other');
	await Promise.all([reopened.close(), sibling.close()]);
});

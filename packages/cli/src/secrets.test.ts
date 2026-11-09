/** Test keychain stores retain plain values per service and reject invalid test seeds. */
import { expect, test } from 'bun:test';
import { keychain, keychainService } from './secrets.ts';

test('test services retain values and bad JSON refuses every method', async () => {
	const previous = process.env.EPICENTER_TEST_SECRETS;
	try {
		process.env.EPICENTER_TEST_SECRETS =
			'{"epicenter.secret-test":{"seed":"plain"}}';
		const service = keychainService('secret-test');
		const store = keychain(service);
		expect(await store.get('seed')).toBe('plain');
		await store.set('token', 'value');
		expect(await store.get('token')).toBe('value');
		expect(await keychain('epicenter.separate').get('token')).toBeUndefined();
		await store.delete('token');
		expect(await store.get('token')).toBeUndefined();
		process.env.EPICENTER_TEST_SECRETS = 'bad json';
		const bad = keychain(service);
		await expect(bad.get('x')).rejects.toThrow(
			'EPICENTER_TEST_SECRETS is not JSON',
		);
		await expect(bad.set('x', 'y')).rejects.toThrow(
			'EPICENTER_TEST_SECRETS is not JSON',
		);
		await expect(bad.delete('x')).rejects.toThrow(
			'EPICENTER_TEST_SECRETS is not JSON',
		);
	} finally {
		if (previous === undefined) delete process.env.EPICENTER_TEST_SECRETS;
		else process.env.EPICENTER_TEST_SECRETS = previous;
	}
});

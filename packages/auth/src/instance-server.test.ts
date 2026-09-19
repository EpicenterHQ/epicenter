/** Server selection canonicalizes equivalent origins and separates instance data addresses. */
import { expect, test } from 'bun:test';
import { normalizeInstanceServer } from './instance-server.js';

test('equivalent origins select the same authority before boot', () => {
	expect(normalizeInstanceServer(' https://EXAMPLE.com:443/ ')).toEqual(
		normalizeInstanceServer('https://example.com'),
	);
	expect(normalizeInstanceServer('https://example.com').authorityId).not.toBe(
		normalizeInstanceServer('https://other.example.com').authorityId,
	);
});
test('server configuration rejects URLs that are not origins', () => {
	for (const value of [
		'https://user:secret@example.com',
		'https://example.com/api',
		'https://example.com?token=x',
		'https://example.com/#x',
		'file:///tmp/server',
	]) {
		expect(() => normalizeInstanceServer(value)).toThrow();
	}
});

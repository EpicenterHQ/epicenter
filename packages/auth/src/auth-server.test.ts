/** Server configuration canonicalizes equivalent origins and separates instance data addresses. */
import { expect, test } from 'bun:test';
import { selfHostedServer } from './auth-server.js';

test('equivalent origins select the same authority before boot', () => {
	expect(selfHostedServer(' https://EXAMPLE.com:443/ ')).toEqual(
		selfHostedServer('https://example.com'),
	);
	expect(selfHostedServer('https://example.com').authorityId).not.toBe(
		selfHostedServer('https://other.example.com').authorityId,
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
		expect(() => selfHostedServer(value)).toThrow();
	}
});

test('the configured origin preserves the existing local-data authority bytes', () => {
	expect(selfHostedServer('https://self.example').authorityId).toBe(
		'instance-68747470733a2f2f73656c662e6578616d706c65',
	);
});

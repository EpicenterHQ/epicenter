/** Hosted handoff query parsing refuses ambiguous callbacks before showing continuation. */
import { expect, test } from 'bun:test';
import { readSessionRequest } from './session-request';

const query = (callback: string) =>
	new URLSearchParams({
		callback,
		challenge: 'c'.repeat(43),
		state: 's'.repeat(43),
	}).toString();

test('browser and native bindings retain their exact callback and deliberate reauthentication', () => {
	for (const callback of [
		'https://app.example/auth/callback',
		'epicenter://auth/callback',
	]) {
		expect(readSessionRequest(query(callback))).toEqual({
			callback,
			challenge: 'c'.repeat(43),
			state: 's'.repeat(43),
			reauthenticate: false,
		});
		expect(
			readSessionRequest(`${query(callback)}&reauth=1`)?.reauthenticate,
		).toBe(true);
	}
});

test('relative credential-bearing and ambiguous bindings have no continuation', () => {
	for (const callback of [
		'//evil.example/auth/callback',
		'/dashboard',
		'https://user@app.example/auth/callback',
		'https://app.example/auth/callback#',
		'https://app.example/auth/callback?next=evil',
	])
		expect(readSessionRequest(query(callback))).toBeNull();
	const valid = query('https://app.example/auth/callback');
	for (const search of [
		'',
		`${valid}&state=other`,
		`${valid}&callback=https://evil.example`,
		valid.replace('c'.repeat(43), 'bad'),
	])
		expect(readSessionRequest(search)).toBeNull();
});

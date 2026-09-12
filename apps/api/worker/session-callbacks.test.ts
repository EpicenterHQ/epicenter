/**
 * Session handoff destinations are exact URLs, independent of CORS trust.
 * Production permits the native callback, hosted session callback, and three
 * app callbacks. Only loopback deployments add the app development callbacks.
 */
import { expect, test } from 'bun:test';
import { buildSessionCallbacks } from './session-callbacks.js';

const appCallbacks = [
	'https://honeycrisp.epicenter.so/auth/callback',
	'https://whispering.epicenter.so/auth/callback',
	'https://vocab.epicenter.so/auth/callback',
];
const localAppCallbacks = [
	'http://127.0.0.1:39131/_epicenter/sign-in/callback',
	'http://localhost:5177/auth/callback',
	'http://localhost:5175/auth/callback',
	'http://localhost:1420/auth/callback',
	'http://localhost:8888/auth/callback',
];

test('only a local issuer admits the exact configured desktop callback port', () => {
	const callback = 'http://127.0.0.1:49152/_epicenter/sign-in/callback';
	expect(buildSessionCallbacks('http://localhost:8787', '49152')).toContain(
		callback,
	);
	expect(buildSessionCallbacks('http://localhost:8787', '49152')).not.toContain(
		localAppCallbacks[0],
	);
	expect(
		buildSessionCallbacks('https://api.epicenter.so', '49152'),
	).not.toContain(callback);
	for (const port of ['0', '1023', '65536', 'other', '39131/path']) {
		expect(() =>
			buildSessionCallbacks('http://localhost:8787', port),
		).toThrow();
	}
});

test('production permits only the exact native, hosted, and application callbacks', () => {
	expect(buildSessionCallbacks('https://api.epicenter.so').sort()).toEqual(
		[
			'epicenter://auth/callback',
			'https://api.epicenter.so/session/callback',
			...appCallbacks,
		].sort(),
	);
});

for (const origin of [
	'http://localhost:8787',
	'http://127.0.0.1:8788',
	'http://[::1]:8787',
]) {
	test(`${origin} adds exactly the application development callbacks`, () => {
		expect(buildSessionCallbacks(origin).sort()).toEqual(
			[
				'epicenter://auth/callback',
				`${origin}/session/callback`,
				...appCallbacks,
				...localAppCallbacks,
			].sort(),
		);
	});
}

for (const origin of [
	'https://preview.example.test',
	'https://localhost.example.test',
	'https://127.0.0.1.example.test',
]) {
	test(`${origin} cannot acquire development callbacks through its hostname`, () => {
		expect(buildSessionCallbacks(origin).sort()).toEqual(
			[
				'epicenter://auth/callback',
				`${origin}/session/callback`,
				...appCallbacks,
			].sort(),
		);
	});
}

test('deployment paths and query strings do not become callback destinations', () => {
	expect(
		buildSessionCallbacks(
			'https://api.epicenter.so/ignored?next=elsewhere#fragment',
		),
	).toEqual(buildSessionCallbacks('https://api.epicenter.so'));
});

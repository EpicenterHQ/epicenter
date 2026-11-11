import { describe, expect, test } from 'bun:test';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

const PROD = buildEpicenterTrustedOrigins('https://api.epicenter.so');
const LOCAL = buildEpicenterTrustedOrigins('http://localhost:8787');

describe('buildEpicenterTrustedOrigins', () => {
	test('neither deployment trusts browser extensions or wildcard origins', () => {
		for (const origins of [PROD, LOCAL]) {
			expect(
				origins.filter((origin) => origin.startsWith('chrome-extension://')),
			).toEqual([]);
			expect(origins.some((origin) => origin.includes('*'))).toBe(false);
		}
	});

	test('a production deployment does not trust localhost dev origins', () => {
		expect(PROD).not.toContain(localUrl(APPS.HONEYCRISP));
		expect(PROD).not.toContain(localUrl(APPS.API));
		expect(PROD).not.toContain(`http://${new URL(APPS.API.url).host}`);
		// `tauri://localhost` is a legitimate production origin, so the check is
		// scoped to http(s) localhost dev servers rather than the substring.
		expect(PROD.some((o) => o.startsWith('http://localhost'))).toBe(false);
	});

	test('a local deployment trusts the localhost dev origins', () => {
		expect(LOCAL).toContain(localUrl(APPS.HONEYCRISP));
		expect(LOCAL).toContain(localUrl(APPS.API));
		expect(LOCAL).toContain(`http://${new URL(APPS.API.url).host}`);
	});

	test('both deployments trust the production app origins', () => {
		expect(PROD).toContain(APPS.HONEYCRISP.url);
		expect(LOCAL).toContain(APPS.HONEYCRISP.url);
	});

	test('is frozen so Cloudflare isolates cannot accumulate mutations', () => {
		expect(Object.isFrozen(PROD)).toBe(true);
		expect(Object.isFrozen(LOCAL)).toBe(true);
	});
});

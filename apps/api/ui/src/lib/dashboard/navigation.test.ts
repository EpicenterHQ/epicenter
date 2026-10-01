import { expect, test } from 'bun:test';
import { readDashboardReturnPath, readDashboardTarget } from './navigation.js';

const origin = 'https://api.example.test';

test('sign-in preserves the purchase account and destination', () => {
	const path = '/dashboard/usage?expectedPrincipal=alice#activity';
	expect(readDashboardReturnPath(path, origin)).toBe(path);
	expect(readDashboardTarget(new URL(path, origin))).toEqual({
		valid: true,
		expectedPrincipal: 'alice',
	});
});

test('direct account visits have no expected identity', () => {
	expect(readDashboardTarget(new URL('/dashboard', origin))).toEqual({
		valid: true,
		expectedPrincipal: null,
	});
});

test('ambiguous or empty expected identities cannot enter a targeted flow', () => {
	for (const query of [
		'expectedPrincipal=',
		'expectedPrincipal=a&expectedPrincipal=b',
		'expectedPrincipal=a%20b',
	]) {
		expect(readDashboardTarget(new URL(`/dashboard?${query}`, origin))).toEqual(
			{ valid: false },
		);
	}
});

test('return navigation cannot escape the dashboard', () => {
	for (const path of [
		null,
		'//evil.test',
		'/\\evil.test',
		'https://evil.test',
		'/sign-in',
		'/dashboard/../sign-in',
		'/dashboard/unknown',
	]) {
		expect(readDashboardReturnPath(path, origin)).toBe('/dashboard');
	}
});

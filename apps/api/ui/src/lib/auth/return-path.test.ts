/** Sign-in continues only to this origin's account pages. */
import { expect, test } from 'bun:test';
import { readReturnPath } from './return-path';

const origin = 'https://api.example.test';
const search = (value: string) => `?${new URLSearchParams({ return: value })}`;

test('account pages keep their exact query', () => {
	for (const path of [
		'/dashboard/usage?expectedPrincipal=alice#activity',
		'/dashboard/account',
	])
		expect(readReturnPath(search(path), origin)).toBe(path);
});

test('anything else continues to the dashboard', () => {
	for (const query of [
		'',
		search('/device?user_code=ABCD-EFGH'),
		search('//evil.test/device'),
		search('/\\evil.test'),
		search('https://evil.test/device'),
		search('/sign-in'),
		search('/consent'),
		search('/devices'),
		`${search('/device')}&return=/dashboard`,
	])
		expect(readReturnPath(query, origin)).toBe('/dashboard');
});

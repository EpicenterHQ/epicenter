/** The authorization server's pages hand back exactly the request it signed. */
import { expect, test } from 'bun:test';
import {
	describeScopes,
	deviceAuthorizeUrl,
	readOAuthRequest,
} from './oauth-request.js';

const signed =
	'response_type=code&client_id=so.epicenter&scope=offline_access+folders%3Aread&prompt=login&state=s&exp=1&ba_iat=2&ba_param=client_id&sig=abc';

test('a signed authorization request keeps its query and resumes without the signature', () => {
	const request = readOAuthRequest(`?${signed}`);
	expect(request?.clientId).toBe('so.epicenter');
	expect(request?.scopes).toEqual(['offline_access', 'folders:read']);
	expect(request?.oauthQuery).toBe(signed);
	const resume = new URL(request?.resumeUrl ?? '', 'https://api.example');
	expect(resume.pathname).toBe('/auth/oauth2/authorize');
	for (const name of ['sig', 'exp', 'ba_iat', 'ba_param', 'prompt'])
		expect(resume.searchParams.has(name)).toBe(false);
	expect(resume.searchParams.get('state')).toBe('s');
});

test("a device code's signed request resumes as that code, before it names a client", () => {
	const signIn = readOAuthRequest(
		'?user_code=ABCD-EFGH&exp=1&ba_iat=2&sig=abc',
	);
	expect(signIn?.clientId).toBeNull();
	expect(signIn?.userCode).toBe('ABCD-EFGH');
	expect(signIn?.resumeUrl).toBe(deviceAuthorizeUrl('ABCD-EFGH'));
	const consent = readOAuthRequest(
		'?user_code=ABCD-EFGH&client_id=so.epicenter.cli&scope=openid+ai&exp=1&sig=abc',
	);
	expect(consent?.clientId).toBe('so.epicenter.cli');
	expect(consent?.userCode).toBe('ABCD-EFGH');
});

test('an unsigned query is not an authorization request', () => {
	expect(readOAuthRequest('?client_id=so.epicenter')).toBeNull();
	expect(readOAuthRequest('?user_code=ABCD-EFGH')).toBeNull();
	expect(readOAuthRequest('')).toBeNull();
});

test('scope lines skip scopes that grant nothing on their own', () => {
	expect(describeScopes(['openid', 'folders:write', 'ai'])).toEqual([
		'Change your folders',
		'Use Epicenter AI on your plan',
	]);
});

test('scope lines ignore inherited object keys and keep declared scopes', () => {
	expect(
		describeScopes(['constructor', 'toString', '__proto__', 'folders:read']),
	).toEqual(['Read your folders']);
});

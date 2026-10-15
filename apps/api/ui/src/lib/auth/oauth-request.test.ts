/** The authorization server's pages hand back exactly the request it signed. */
import { expect, test } from 'bun:test';
import { describeScopes, readOAuthRequest } from './oauth-request';

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

test('an unsigned query is not an authorization request', () => {
	expect(readOAuthRequest('?client_id=so.epicenter')).toBeNull();
	expect(readOAuthRequest('')).toBeNull();
});

test('scope lines skip scopes that grant nothing on their own', () => {
	expect(describeScopes(['openid', 'folders:write', 'ai'])).toEqual([
		'Change your folders',
		'Use Epicenter AI on your plan',
	]);
});

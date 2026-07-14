/**
 * Workspace Authority Tests
 *
 * Verifies the canonical local-or-server authority used to partition browser
 * replicas without exposing principal ids in filenames.
 *
 * Key behaviors:
 * - equivalent server URLs normalize to one authority
 * - deployment paths and principals produce distinct hashes
 * - credentials and non-HTTP server identities are refused
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	normalizeWorkspaceAuthority,
	normalizeWorkspaceServerBaseURL,
	workspaceAuthorityHash,
} from './workspace-authority.js';

test('equivalent server URLs normalize to one authority hash', async () => {
	const principalId = asPrincipalId('principal-1');
	const first = await workspaceAuthorityHash({
		kind: 'server',
		baseURL: 'HTTPS://Example.COM:443/api/',
		principalId,
	});
	const second = await workspaceAuthorityHash({
		kind: 'server',
		baseURL: 'https://example.com/api',
		principalId,
	});

	expect(first).toBe(second);
	expect(first).toMatch(/^[0-9a-f]{64}$/);
});

test('deployment paths and principals produce distinct authority hashes', async () => {
	const values = await Promise.all([
		workspaceAuthorityHash({
			kind: 'server',
			baseURL: 'https://example.com/one',
			principalId: asPrincipalId('principal-1'),
		}),
		workspaceAuthorityHash({
			kind: 'server',
			baseURL: 'https://example.com/two',
			principalId: asPrincipalId('principal-1'),
		}),
		workspaceAuthorityHash({
			kind: 'server',
			baseURL: 'https://example.com/one',
			principalId: asPrincipalId('principal-2'),
		}),
	]);

	expect(new Set(values).size).toBe(values.length);
});

test('authority validation refuses ambiguous or credential-bearing servers', () => {
	expect(normalizeWorkspaceServerBaseURL('https://example.com/')).toBe(
		'https://example.com/',
	);
	expect(() => normalizeWorkspaceServerBaseURL('ftp://example.com')).toThrow(
		'HTTP or HTTPS',
	);
	expect(() =>
		normalizeWorkspaceServerBaseURL('https://user@example.com'),
	).toThrow('credentials');
	expect(() =>
		normalizeWorkspaceServerBaseURL('https://example.com/?tenant=one'),
	).toThrow('search or hash');
	expect(() =>
		normalizeWorkspaceAuthority({
			kind: 'server',
			baseURL: 'https://example.com',
			principalId: asPrincipalId(''),
		}),
	).toThrow('principal id');
});

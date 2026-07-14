import { describe, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { toWorkspaceAuthority } from './to-workspace-authority.js';

describe('toWorkspaceAuthority', () => {
	test('selects the local authority while signed out', () => {
		expect(
			toWorkspaceAuthority({
				state: { status: 'signed-out' },
				deployment: { kind: 'hosted', baseURL: 'https://api.example.com' },
			}),
		).toEqual({ kind: 'local' });
	});

	test.each([
		'signed-in',
		'reauth-required',
	] as const)('selects the principal server authority while %s', (status) => {
		const principalId = asPrincipalId('principal-1');
		expect(
			toWorkspaceAuthority({
				state: { status, principalId },
				deployment: {
					kind: 'hosted',
					baseURL: 'https://api.example.com',
				},
			}),
		).toEqual({
			kind: 'server',
			baseURL: 'https://api.example.com',
			principalId,
		});
	});
});

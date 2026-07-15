import { describe, expect, test } from 'bun:test';
import type { SyncAuthClient } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/identity';
import { toWorkspaceConnection } from './to-workspace-connection.js';

function auth(state: SyncAuthClient['state']): SyncAuthClient {
	return {
		state,
		deployment: { kind: 'hosted', baseURL: 'https://api.example.com' },
		fetch,
		openWebSocket: () => new Promise<never>(() => {}),
		onStateChange: () => () => {},
	} as unknown as SyncAuthClient;
}

describe('toWorkspaceConnection', () => {
	test('selects local while signed out', () => {
		expect(toWorkspaceConnection(auth({ status: 'signed-out' }))).toEqual({
			kind: 'local',
		});
	});

	test.each([
		'signed-in',
		'reauth-required',
	] as const)('selects the principal server connection while %s', (status) => {
		const principalId = asPrincipalId('principal-1');
		const connection = toWorkspaceConnection(auth({ status, principalId }));
		expect(connection).toMatchObject({
			kind: 'server',
			baseURL: 'https://api.example.com',
			principalId,
		});
	});
});

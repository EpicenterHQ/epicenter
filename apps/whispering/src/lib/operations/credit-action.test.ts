/**
 * A credit recovery action opens the account that failed, even after the caller's
 * current account changes. Opening account management performs no credit read or
 * transcription retry; unrelated failures retain their usual presentation.
 */
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { creditAction } from './credit-action.js';

test('Add credits captures the failing account and only opens its website', () => {
	const account = {
		baseURL: 'https://alice.example.test',
		principalId: asPrincipalId('alice'),
		fetch: mock(() => {
			throw new Error('Opening account management must not request credits');
		}),
	};
	const open = mock();
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { open },
	});
	try {
		const action = creditAction(
			{ name: 'InsufficientCredits', message: 'Out of credits' },
			account,
		);
		expect(open).not.toHaveBeenCalled();
		account.baseURL = 'https://bob.example.test';
		account.principalId = asPrincipalId('bob');
		expect(action?.label).toBe('Add credits');
		action?.onClick();
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(
			'https://alice.example.test/dashboard?expectedPrincipal=alice',
			'_blank',
			'noopener',
		);
		expect(account.fetch).not.toHaveBeenCalled();
	} finally {
		if (previousWindow)
			Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('unrelated transcription errors do not offer a credit purchase', () => {
	expect(
		creditAction(
			{ name: 'RequestFailed', message: 'Offline' },
			{
				baseURL: 'https://api.example.test',
				principalId: asPrincipalId('alice'),
			},
		),
	).toBeUndefined();
});

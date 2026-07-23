/**
 * Account Deletion Coordinator Tests
 *
 * Verifies the retry-safe ordering contract of hosted account deletion.
 *
 * Key behaviors:
 * - steps run in the documented order with the auth user last
 * - the first failure stops the sequence and names the failed step
 * - a retry re-runs every step (each step owns its own idempotency)
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { type AccountDeletionStep, runAccountDeletion } from './service.js';

const alice = asPrincipalId('alice');

function recordingSteps(failing?: AccountDeletionStep) {
	const calls: AccountDeletionStep[] = [];
	const step = (name: AccountDeletionStep) => async () => {
		calls.push(name);
		if (name === failing) throw new Error(`${name} unavailable`);
	};
	return {
		calls,
		steps: {
			authority: step('authority'),
			billing: step('billing'),
			observations: step('observations'),
			'auth-user': step('auth-user'),
			reportError: () => undefined,
		},
	};
}

test('deletion runs every step in order with the auth user last', async () => {
	const { calls, steps } = recordingSteps();
	expect(await runAccountDeletion(steps, alice)).toEqual({
		outcome: 'deleted',
	});
	expect(calls).toEqual(['authority', 'billing', 'observations', 'auth-user']);
});

test('the first failing step stops the sequence and is named for retry', async () => {
	const { calls, steps } = recordingSteps('billing');
	expect(await runAccountDeletion(steps, alice)).toEqual({
		outcome: 'incomplete',
		failedStep: 'billing',
	});
	// The auth user survives every partial failure, so the retry below can
	// still authenticate; each step re-runs because steps own idempotency.
	expect(calls).toEqual(['authority', 'billing']);
	const retry = recordingSteps();
	expect(await runAccountDeletion(retry.steps, alice)).toEqual({
		outcome: 'deleted',
	});
	expect(retry.calls).toEqual([
		'authority',
		'billing',
		'observations',
		'auth-user',
	]);
});

test('an auth-user failure reports incomplete even after storage is gone', async () => {
	const { steps } = recordingSteps('auth-user');
	expect(await runAccountDeletion(steps, alice)).toEqual({
		outcome: 'incomplete',
		failedStep: 'auth-user',
	});
});

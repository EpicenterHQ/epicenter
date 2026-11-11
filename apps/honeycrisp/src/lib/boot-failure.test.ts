import { describe, expect, test } from 'bun:test';
import { bootFailureMessage } from './boot-failure.js';

/**
 * The seam between what the store says and what a person reads.
 *
 * The point of these is not the wording, which will change. It is that a boot
 * failure never reaches a person as library vocabulary, and that a failure with
 * a specific repair says the repair rather than "restart".
 */
describe('bootFailureMessage', () => {
	test('a refused account credential says to sign in again', () => {
		for (const name of ['Unaddressable', 'CredentialRefused']) {
			expect(
				bootFailureMessage({ name, message: 'internal' }, 'account'),
			).toMatch(/sign in again/i);
		}
	});

	test('a local open failure suggests restarting without asking for sign-in', () => {
		const message = bootFailureMessage({ name: 'Unaddressable' }, 'local');
		expect(message).toMatch(/restart/i);
		expect(message).not.toMatch(/sign in/i);
	});

	test('a second window says to close the other one', () => {
		expect(
			bootFailureMessage({
				name: 'AlreadyOpen',
				message: 'This process already has epicenter/x/local open',
			}),
		).toMatch(/another honeycrisp window/i);
	});

	test('an unrecognized failure admits it rather than inventing a reason', () => {
		const unknown = bootFailureMessage(
			{
				name: 'UnknownFailure',
				message: 'The store could not be opened',
			},
			'account',
		);
		expect(unknown).toMatch(/something went wrong/i);
		// It still tells them their notes are safe, which is the one thing
		// somebody staring at a failed boot actually wants to know.
		expect(unknown).toMatch(/notes on this device are still available/i);
	});

	test('no arm leaks store vocabulary to a person', () => {
		const machineWords =
			/replica|authority|database|document|log|head|dial|socket|struct|principal|projection/i;
		for (const error of [
			{ name: 'AlreadyOpen' },
			{ name: 'Unaddressable' },
			{ name: 'CredentialRefused' },
			{ name: 'UnknownFailure' },
			new Error('boom'),
			'not an object',
			null,
		]) {
			expect(bootFailureMessage(error)).not.toMatch(machineWords);
		}
	});
});

/**
 * Settings' AI connections reach their endpoints and keys through this
 * computer's keychain, by the `epicenter` CLI's key commands (ADR-0557).
 */

import type { ConnectionKeys } from '@epicenter/ai/ui';
import { type CliError, commands } from '../bindings.gen';

/** What a person is told when a key command did not run or was refused. */
export function failureText(error: CliError) {
	return error.name === 'NotGranted'
		? 'This window was not granted the folder.'
		: error.message;
}

const readable = <T>(
	result: { data: T; error: null } | { data: null; error: CliError },
) =>
	result.error === null
		? result
		: { data: null, error: failureText(result.error) };

/** The keychain, as the shared connection editor reaches it. */
export const keychainKeys: ConnectionKeys = {
	place: 'computer',
	state: async (connection) => readable(await commands.aiKeyState(connection)),
	save: async (connection, endpoint, key) =>
		readable(await commands.aiKeySet(connection, endpoint, key)),
	remove: async (connection) =>
		readable(await commands.aiKeyRemove(connection)),
};

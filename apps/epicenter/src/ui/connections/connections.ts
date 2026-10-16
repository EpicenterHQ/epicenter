/**
 * Settings' AI connections reach their endpoints and keys through this
 * computer's keychain, by the `epicenter` CLI's key commands (ADR-0557).
 */

import { keychainKeys as keysOver } from '@epicenter/ai/ui';
import { type CliError, commands } from '../bindings.gen';

/** What a person is told when a CLI command did not run or was refused. */
export function failureText(error: CliError) {
	return error.name === 'NotGranted'
		? 'This window was not granted the folder.'
		: error.message;
}

/** The keychain, as the shared connection editor reaches it. */
export const keychainKeys = keysOver({ ...commands, describe: failureText });

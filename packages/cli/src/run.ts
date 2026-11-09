/**
 * One action's run, for the command line and MCP (ADR-0850). The action
 * writes through its folder as it runs and commits only if it calls
 * `folder.commit`; `epicenter` records nothing, checks no repository, and
 * commits nothing of its own. The answer is what the action returned or
 * threw.
 */
import type { Action } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { folderOnDisk } from './disk.ts';
import type { Runnable } from './home.ts';
import type { Answer } from './report.ts';
import { keychain, keychainService } from './secrets.ts';

/**
 * What the action threw, as the answer carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole so its name and fields reach the caller.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Record<string, unknown>;
} {
	const message = extractErrorMessage(cause);
	if (typeof cause !== 'object' || cause === null || cause instanceof Error)
		return { message };
	const { name } = cause as { name?: unknown };
	if (
		typeof name !== 'string' ||
		typeof (cause as { message?: unknown }).message !== 'string'
	)
		return { message };
	return { message, thrown: JSON.parse(JSON.stringify(cause)) };
}

/** Run `action` with its checked input in the app's folder. */
export async function runAction(
	located: Runnable,
	action: Action,
	input: Record<string, unknown>,
): Promise<Exclude<Answer, { error: unknown }>> {
	try {
		const returned = await action.run(input, {
			folder: folderOnDisk(located.realPath),
			secrets: keychain(keychainService(located.name)),
		});
		return { returned: returned ?? null };
	} catch (error) {
		return { threw: threwOf(error) };
	}
}

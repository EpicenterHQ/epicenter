/**
 * The shared execution of app actions (ADR-0841). CLI and MCP supply checked
 * input here and receive the same return value or thrown message.
 */
import type { Located } from './home.ts';
import { cacheOnDisk, folderOnDisk } from './places.ts';
import { keychain } from './secrets.ts';

/**
 * The one place an action runs, for the command line and MCP. Wave 1c wraps
 * this function with the commit (ADR-0842), keeping both callers on that path.
 */
export async function runAction(
	located: Located,
	key: string,
	input: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	try {
		const action = located.app?.actions[key];
		if (!action) throw new Error(`Unknown action ${located.name} ${key}`);
		const value = await action.run(input, {
			folder: folderOnDisk(located.realPath),
			cache: cacheOnDisk(located.cacheDir),
			secrets: keychain(located.keychain),
		});
		return { ok: true, value };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

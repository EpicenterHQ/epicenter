/**
 * This `epicenter`'s version, and the oldest one an app runs on: the floor its
 * `package.json` declares as `engines.epicenter`, as an extension declares
 * `engines.vscode` (ADR-0873). npm and Bun ignore the field when installing.
 * An app that declares none makes no claim, and runs on any `epicenter`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

export const VERSION = packageJson.version;

/** The floor `epicenter new` writes into a new app: this version. */
export const ENGINES = { epicenter: `>=${VERSION}` };

/** Why this `epicenter` cannot run the app in `folder`, or undefined when it can. */
export async function enginesProblem(
	folder: string,
): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(join(folder, 'package.json'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
	let range: unknown;
	try {
		range = (JSON.parse(text) as { engines?: { epicenter?: unknown } }).engines
			?.epicenter;
	} catch (error) {
		return `package.json is not JSON: ${(error as Error).message}`;
	}
	if (range === undefined) return undefined;
	if (typeof range === 'string' && Bun.semver.satisfies(VERSION, range))
		return undefined;
	return `package.json asks for epicenter ${JSON.stringify(range)}, and this is epicenter ${VERSION}; update epicenter`;
}

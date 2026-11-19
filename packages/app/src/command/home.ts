/**
 * Find the home a command runs in. The marker is the first `package.json`,
 * walking up from where the command runs, with an `"epicenter"` key; its
 * `port` is where serve listens:
 *
 * ```json
 * { "private": true, "epicenter": { "port": 4747 } }
 * ```
 *
 * A `package.json` without the key, such as one an app keeps for its own
 * dependencies, is walked past. Nothing here imports app code, so the
 * command learns the port without loading a single app.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';
import { ActionError, type NotStarted } from '../errors.ts';
import { isPlainObject } from '../result.ts';

/** A home, found once and passed to everything that reads it. */
export type Home = {
	/** Its real path. */
	folder: string;
	/** The port serve listens on. */
	port: number;
};

/** The parsed `package.json` in `folder`, or undefined when there is none or it is not JSON. */
function packageIn(folder: string): unknown {
	let text: string;
	try {
		text = readFileSync(join(folder, 'package.json'), 'utf8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isPort(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 65535
	);
}

/**
 * The home a command started in `start` acts on: the nearest folder at or
 * above it whose `package.json` has an `"epicenter"` key, as Git finds the
 * nearest `.git`.
 */
export function findHome(start = process.cwd()): Result<Home, NotStarted> {
	let folder = start;
	for (;;) {
		const found = packageIn(folder);
		if (isPlainObject(found) && Object.hasOwn(found, 'epicenter')) {
			const settings = found.epicenter;
			const port = isPlainObject(settings) ? settings.port : undefined;
			if (!isPort(port))
				return ActionError.NotStarted({
					message: `${join(folder, 'package.json')}: "epicenter" needs a port, a whole number from 1 to 65535, such as "epicenter": { "port": 4747 }`,
				});
			return Ok({ folder: realpathSync(folder), port });
		}
		const parent = dirname(folder);
		if (parent === folder)
			return ActionError.NotStarted({
				message:
					'There is no package.json with an "epicenter" key here or above; cd into your home',
			});
		folder = parent;
	}
}

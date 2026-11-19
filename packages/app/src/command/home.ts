/**
 * Find the Epicenter a command runs in. The marker is the first `package.json`,
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
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';
import { ActionError, type NotStarted } from '../answer.ts';
import { readBytes } from '../disk.ts';
import { isPlainObject, parseJson } from '../json.ts';

/**
 * Where an Epicenter folder was found, and the port its serve listens on.
 * "Home" is the code name for that folder; the docs call it your Epicenter.
 * Found once and passed to everything that reads it.
 */
export type Home = {
	/** Its real path. */
	folder: string;
	/** The port serve listens on. */
	port: number;
};

function isPort(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 65535
	);
}

/**
 * The Epicenter a command started in `start` acts on: the nearest folder at or
 * above it whose `package.json` has an `"epicenter"` key, as Git finds the
 * nearest `.git`.
 */
export function findHome(start = process.cwd()): Result<Home, NotStarted> {
	let folder = start;
	for (;;) {
		const file = join(folder, 'package.json');
		const bytes = readBytes(file);
		const found = bytes && parseJson(new TextDecoder().decode(bytes));
		// Walking past a broken one could reach an outer home and act on it.
		if (bytes && found === undefined)
			return ActionError.NotStarted({
				message: `${file} is not JSON, so it cannot say whether this is an Epicenter; fix it`,
			});
		if (isPlainObject(found) && Object.hasOwn(found, 'epicenter')) {
			const settings = found.epicenter;
			const port = isPlainObject(settings) ? settings.port : undefined;
			if (!isPort(port))
				return ActionError.NotStarted({
					message: `${file}: "epicenter" needs a port, a whole number from 1 to 65535, such as "epicenter": { "port": 4747 }`,
				});
			return Ok({ folder: realpathSync(folder), port });
		}
		const parent = dirname(folder);
		if (parent === folder)
			return ActionError.NotStarted({
				message:
					'There is no package.json with an "epicenter" key here or above; cd into your Epicenter folder',
			});
		folder = parent;
	}
}

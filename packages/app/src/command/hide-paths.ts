/**
 * Hide this computer's folders in what serve sends to another device
 * (ADR-0961). A phone or laptop reaches serve through the owner's private
 * network, and a message such as `EACCES: permission denied, stat
 * '/Users/<account>/Epicenter/apps/notes'` would show it the account name.
 *
 * Serve applies this once, where a failure leaves it: the error of every
 * HTTP and MCP answer, a refusal before a call, and the problems and
 * routines in the listing. The Epicenter's real path reads `.` and the home
 * folder reads `~`, as plain paths or as `file://` URLs. A path outside both
 * is left as it is, and so is what an action returns as data or sends as an
 * update: that is the action's to choose. Serve's own log keeps full paths.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Answer } from '../index.ts';
import type { EpicenterRoot } from './root.ts';

/** `path` as a pattern that matches only a whole path, not the start of a longer name. */
const wholePath = (path: string) =>
	new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g');

export function hidePaths({ folder }: Pick<EpicenterRoot, 'folder'>) {
	const home = homedir();
	let realHome = home;
	try {
		realHome = realpathSync(home);
	} catch {
		// A home that cannot be resolved is hidden as it is spelled.
	}
	const shown: [string, string][] = [
		[folder, '.'],
		[realHome, '~'],
		[home, '~'],
	];
	// The longest first, so the Epicenter inside the home folder reads `.`.
	const patterns = shown
		.flatMap(([path, short]): [string, string][] => [
			[path, short],
			[pathToFileURL(path).href, short],
		])
		.sort(([a], [b]) => b.length - a.length)
		.map(([path, short]) => [wholePath(path), short] as const);
	const text = (value: string) =>
		patterns.reduce(
			(each, [pattern, short]) => each.replace(pattern, short),
			value,
		);
	const value = <T>(given: T): T => {
		if (typeof given === 'string') return text(given) as T;
		if (Array.isArray(given)) return given.map(value) as T;
		if (typeof given === 'object' && given !== null)
			return Object.fromEntries(
				Object.entries(given).map(([key, each]) => [key, value(each)]),
			) as T;
		return given;
	};
	return {
		/** `message` with the folders hidden. */
		text,
		/** Every string in a plain value, with the folders hidden. */
		value,
		/** An answer with its error's folders hidden; its data is the action's. */
		answer: (answer: Answer): Answer =>
			answer.error ? { data: null, error: value(answer.error) } : answer,
	};
}

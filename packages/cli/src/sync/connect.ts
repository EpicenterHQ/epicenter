/**
 * Attach an initialized folder to an ordinary Git origin, through the sync
 * core. Sync owns transfers: connecting runs no round.
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect as attach, locate } from '@epicenter/core';
import { Refused } from './setup.ts';

export async function connect(input: string, url: string) {
	const folder = resolve(input);
	const target = await realpath(folder).catch(() => null);
	const found = target === null ? null : locate(target);
	if (found === null || found.root !== target || !found.synced)
		throw new Refused(
			`${input} is not set up for sync. Run epicenter init ${input} first.`,
		);
	try {
		return { folder, url, changed: attach(found.root, url) };
	} catch (error) {
		throw new Refused(error instanceof Error ? error.message : String(error));
	}
}

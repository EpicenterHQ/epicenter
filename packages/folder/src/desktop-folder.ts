/**
 * A standalone desktop app's two roots, which the shell names at startup:
 * its data folder, `<library root>/<name>` from its bundle identifier, and
 * its AppData root for machine-local settings. Each opens by name; the page
 * never holds either one's path except to show it (`displayPath`).
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { withAgentsNote } from './agents-note.js';
import { storeOf } from './device/client.js';
import type { OpenDeviceError } from './errors.js';
import { openDevice } from './tauri.js';

const log = createLogger('folder/desktop');

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/** Open an app's machine-local settings contract at its AppData root. */
export async function openAppData<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	return openDevice(contract, { root: 'AppData' });
}

/**
 * Open the app's data folder, which the shell makes when nothing is at its
 * path, then bring its root `AGENTS.md` note up to date with the site's contract.
 * A data folder behind a link whose target is gone is `Disconnected`, and
 * nothing is made. The note is advice for agents, so a note that cannot be
 * read or updated (malformed by hand, or changing underneath) never stops
 * the app from opening its data: it is left as it is.
 */
export async function openDataFolder<TContract extends Contract>(
	contract: TContract,
	site: string,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	const opened = await openDevice(contract, { root: 'Data' });
	if (opened.error !== null) return opened;
	await refreshAgentsNote(opened.data, contract, `${site}/contract.json`);
	return Ok(opened.data);
}

/**
 * Write or update the folder's `AGENTS.md`; `true` once it is current.
 * Anything it cannot do leaves the note untouched.
 */
async function refreshAgentsNote<TContract extends Contract>(
	device: Client<TContract>,
	contract: TContract,
	contractUrl: string,
): Promise<boolean> {
	const store = storeOf(device);
	for (let attempt = 0; attempt < 3; attempt++) {
		const read = await store.read('AGENTS.md');
		if (read.error !== null) {
			log.debug('Could not read AGENTS.md', { error: read.error });
			return false;
		}
		let current: string | null = null;
		let wanted: string;
		try {
			if (read.data !== null)
				current = new TextDecoder('utf-8', { fatal: true }).decode(
					read.data.bytes,
				);
			wanted = withAgentsNote(current, contract, contractUrl);
		} catch (error) {
			log.debug('Could not prepare AGENTS.md', { error });
			return false;
		}
		if (wanted === current) return true;
		const written = await store.write(
			'AGENTS.md',
			new TextEncoder().encode(wanted),
			read.data === null ? 'absent' : { sha256: read.data.version },
		);
		if (written.error !== null) {
			log.debug('Could not write AGENTS.md', { error: written.error });
			return false;
		}
		if (written.data === 'landed') return true;
	}
	log.debug('Could not update AGENTS.md after three attempts');
	return false;
}

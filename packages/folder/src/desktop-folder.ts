/**
 * The desktop app's data folder: `<library root>/<name>` from its bundle
 * identifier, which the shell names at startup as the `Data` root. Its root
 * `AGENTS.md` links the contract the app's site publishes (ADR-0772).
 */
import type { Contract } from '@epicenter/definition/contract';
import { createLogger } from 'wellcrafted/logger';
import { withAgentsNote } from './agents-note.js';
import type { Store } from './device/store.js';

const log = createLogger('folder/desktop');

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/**
 * Write or update the root `AGENTS.md` note in `store` so it links
 * `contractUrl` and names `contract`'s paths; `true` once it is current.
 * The note is advice for agents, so a note that cannot be read or updated
 * (malformed by hand, or changing underneath) never stops the app from
 * opening its data: it is left as it is.
 */
export async function refreshAgentsNote(
	store: Store,
	contract: Contract,
	contractUrl: string,
): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const read = await store.read(['AGENTS.md']);
		if (read.error !== null) {
			log.debug('Could not read AGENTS.md', { error: read.error });
			return false;
		}
		const [file] = read.data;
		const there = file === undefined || 'gone' in file ? null : file;
		let current: string | null = null;
		let wanted: string;
		try {
			if (there !== null)
				current = new TextDecoder('utf-8', { fatal: true }).decode(there.bytes);
			wanted = withAgentsNote(current, contract, contractUrl);
		} catch (error) {
			log.debug('Could not prepare AGENTS.md', { error });
			return false;
		}
		if (wanted === current) return true;
		const written = await store.put(
			'AGENTS.md',
			new TextEncoder().encode(wanted),
			there === null ? null : there.version,
		);
		if (written.error === null) return true;
		if (written.error.name !== 'Moved') {
			log.debug('Could not write AGENTS.md', { error: written.error });
			return false;
		}
	}
	log.debug('Could not update AGENTS.md after three attempts');
	return false;
}

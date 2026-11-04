/**
 * Does `bun build --compile` carry the addon? A static `require` of the
 * `.node` file lets Bun embed it.
 *
 * `bun build --compile packages/sync-core/bench/compile-probe.ts --outfile /tmp/probe`
 * then `/tmp/probe <folder> <file:// remote>` from any directory.
 */
import { settleNote } from '../settle-note.ts';

const addon = require('../sync_core.node') as {
	libgit2Version(): string;
	syncRound(
		folder: string,
		options: { machine: string; remote?: { url: string } },
		settle: typeof settleNote,
	): { status: string; notes: string[]; message?: string };
};

console.log(`libgit2 ${addon.libgit2Version()}`);
const [folder, url] = process.argv.slice(2);
if (folder && url) {
	const round = addon.syncRound(folder, { machine: 'compiled probe', remote: { url } }, settleNote);
	console.log(round.status, round.message ?? '', round.notes.join('; '));
}

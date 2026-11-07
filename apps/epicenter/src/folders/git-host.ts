/**
 * This computer's Git as the Folders window reaches it: the `GitHost`
 * `importGit` runs on, over the shell's Git commands (`src-tauri/src/git.rs`),
 * which a page cannot do itself. Bytes cross as base64.
 */
import type { GitHost } from '@epicenter/folder/platform';
import { commands } from '../ui/bindings.gen';

const toBase64 = (bytes: Uint8Array) => {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(text);
};

const fromBase64 = (encoded: string) =>
	Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));

/** What the shell answered, or its refusal thrown: an import reports what stopped it. */
function answered<T>(
	result: { data: T; error: null } | { data: null; error: string },
): T {
	if (result.error !== null) throw new Error(result.error);
	return result.data as T;
}

export const shellGit: GitHost = {
	async run(args, { cwd, input } = {}) {
		const run = answered(
			await commands.gitRun(
				[...args],
				cwd ?? null,
				input === undefined ? null : toBase64(input),
			),
		);
		return {
			code: run.code,
			stdout: fromBase64(run.stdout),
			stderr: run.stderr,
		};
	},
	async scratch() {
		const path = answered(await commands.gitScratch());
		return {
			path,
			remove: async () => void answered(await commands.gitScratchRemove(path)),
		};
	},
	async lfsObject(dir, oid) {
		const bytes = answered(await commands.gitLfsObject(dir, oid));
		return bytes === null ? null : fromBase64(bytes);
	},
	async handOver({ from, to, target }) {
		answered(await commands.gitHandOver(from, to, target));
	},
};

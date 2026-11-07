/**
 * `epicenter export --git <dir>` and `epicenter import --git <repository>`
 * (ADR-0824, ADR-0826, ADR-0827): a folder's history leaving Epicenter as
 * a Git repository, and a Git repository's history entering as a folder,
 * or an import that stopped resumed or abandoned.
 *
 * Exit codes: 0 done, 2 what the operation cannot use (no `git`, not
 * synced here, a repository it cannot read or write, the server out of
 * reach).
 */
import { resolve } from 'node:path';
import { Err, Ok } from 'wellcrafted/result';
import { authContext } from '../auth.ts';
import { homeRoot } from '../folder-commands.ts';
import type { ImplementationOf } from '../operation.ts';
import type {
	exportGit as exportOperation,
	importGit as importOperation,
} from '../operations.ts';
import { count, writeErr, writeOut } from '../output.ts';
import { signedInNow } from '../sync/account.ts';
import { syncedFolder } from '../sync/history.ts';
import { exportGit as writeExport } from './export.ts';
import { abandonImport, importGit as readImport } from './import.ts';

const message = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * `epicenter export [<dir>] --git <repository>`: write the history of the
 * folder `dir` names (this directory by default) into the Git repository
 * at `<repository>`, made when absent, adding only what is new since the
 * last export there.
 */
export const exportGit: ImplementationOf<typeof exportOperation> = {
	async run({ dir, git }) {
		const at = await syncedFolder(dir);
		if (at.error !== null) return at;
		try {
			const report = await writeExport({
				folder: at.data.record.folder,
				history: at.data.folder,
				dir: resolve(git),
			});
			return Ok({ output: { export: report } });
		} catch (cause) {
			return Err(message(cause));
		}
	},
	print({ export: report }) {
		writeOut(
			report.to === report.from
				? `${report.dir} holds every change already (${report.to}).`
				: `${report.dir}: ${count(report.to - report.from, 'change')} written (${report.from + 1} to ${report.to}), ${count(report.tags.length, 'tag')}`,
		);
		for (const { seq, path, version } of report.purged)
			writeErr(
				`${path} at change ${seq}: its bytes were purged, so it is a pointer to ${version} only`,
			);
		for (const { seq, path, reason } of report.skipped)
			writeErr(`${path} at change ${seq}: left out (${reason})`);
		if (report.checkout === 'left' && report.to !== report.from)
			writeErr(
				`${report.dir}'s checkout had changes of its own, so it was left as it was; main has the new commits`,
			);
	},
};

/**
 * `epicenter import --git <repository> [--branch <name>] [--name <name>]
 * [--replace-original]`: make a folder from a Git repository's history, in
 * a new directory of the Epicenter folder, synced. `--resume` continues an
 * import that stopped midway (of `--git`, or the only one waiting), and
 * `--abandon <folder>` deletes one that still imports.
 */
export const importGit: ImplementationOf<typeof importOperation> = {
	async run({ git, branch, name, replaceOriginal, resume, abandon }) {
		if (abandon !== undefined && (git !== undefined || resume))
			return Err(
				'--abandon <folder> gives up an import; give it alone, without --git or --resume.',
			);
		if (abandon === undefined && git === undefined && !resume)
			return Err('Name the repository to read: --git <path or URL>.');
		const signedIn = await signedInNow(authContext());
		if (signedIn.error !== null) return Err(signedIn.error);
		try {
			if (abandon !== undefined)
				return Ok({
					output: {
						abandon: await abandonImport({
							account: signedIn.data,
							root: homeRoot(),
							target: abandon,
						}),
					},
				});
			return Ok({
				output: {
					import: await readImport({
						source: git,
						resume,
						branch,
						name,
						replaceOriginal,
						account: signedIn.data,
						root: homeRoot(),
					}),
				},
			});
		} catch (cause) {
			return Err(message(cause));
		}
	},
	print(output) {
		const gone = output.abandon;
		if (gone !== undefined) {
			writeOut(
				`The import of ${gone.folder} is abandoned: ${gone.server === 'abandoned' ? 'its folder is deleted on the server' : 'its folder was gone from the server already'}${gone.removed === null ? '' : `, and ${gone.removed} is removed`}.`,
			);
			return;
		}
		const report = output.import;
		if (report === undefined) return;
		writeOut(
			`${report.path}: ${count(report.changes, 'change')} from ${count(report.commits, 'commit')} of ${report.branch}${report.resumed > 0 ? ` (${report.resumed} landed before this run)` : ''}, ${count(report.marks.length, 'mark')}; synced as folder ${report.folder}`,
		);
		for (const warning of report.warnings) writeErr(warning);
		if (report.original !== null)
			writeErr(
				`The original is at ${report.original.movedTo}, its .git within it; ${report.original.link} now links to ${report.path}.`,
			);
	},
};

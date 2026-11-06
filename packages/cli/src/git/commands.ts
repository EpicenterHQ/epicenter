/**
 * `epicenter export --git <dir>` and `epicenter import --git <repository>`
 * (ADR-0824, ADR-0826): a folder's history leaving Epicenter as a Git
 * repository, and a Git repository's history entering as a folder.
 *
 * Exit codes: 0 done, 2 what the command cannot use (no `git`, not synced
 * here, a repository it cannot read or write, the server out of reach).
 */
import { resolve } from 'node:path';
import { authContext } from '../auth.ts';
import { homeRoot } from '../folder-commands.ts';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import { signedInNow } from '../sync/account.ts';
import { syncedFolder } from '../sync/history.ts';
import { exportGit } from './export.ts';
import { abandonImport, importGit } from './import.ts';

type Options = Record<string, string | true>;

const message = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * `epicenter export [<dir>] --git <repository>`: write the history of the
 * folder `dir` names (this directory by default) into the Git repository
 * at `<repository>`, made when absent, adding only what is new since the
 * last export there.
 */
export async function exportCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	if (typeof options.git !== 'string')
		return fail('Name the repository to write: --git <dir>.', json);
	const at = await syncedFolder(dir);
	if (at.error !== null) return fail(at.error, json);
	let report: Awaited<ReturnType<typeof exportGit>>;
	try {
		report = await exportGit({
			folder: at.data.record.folder,
			history: at.data.folder,
			dir: resolve(options.git),
		});
	} catch (cause) {
		return fail(message(cause), json);
	}
	if (json) writeJson({ export: report });
	else {
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
	}
	return EXIT.ok;
}

/**
 * `epicenter import --git <repository> [--branch <name>] [--name <name>]
 * [--replace-original]`: make a folder from a Git repository's history, in
 * a new directory of the Epicenter folder, synced. `--resume` continues an
 * import that stopped midway (of `--git`, or the only one waiting), and
 * `--abandon <folder>` deletes one that still imports.
 */
export async function importCommand(options: Options, json: boolean) {
	const source = typeof options.git === 'string' ? options.git : undefined;
	const abandon =
		typeof options.abandon === 'string' ? options.abandon : undefined;
	const resume = options.resume === true;
	if (abandon !== undefined && (source !== undefined || resume))
		return fail(
			'--abandon <folder> gives up an import; give it alone, without --git or --resume.',
			json,
		);
	if (abandon === undefined && source === undefined && !resume)
		return fail('Name the repository to read: --git <path or URL>.', json);
	const signedIn = await signedInNow(authContext());
	if (signedIn.error !== null) return fail(signedIn.error, json);
	if (abandon !== undefined) {
		let gone: Awaited<ReturnType<typeof abandonImport>>;
		try {
			gone = await abandonImport({
				account: signedIn.data,
				root: homeRoot(),
				target: abandon,
			});
		} catch (cause) {
			return fail(message(cause), json);
		}
		if (json) writeJson({ abandon: gone });
		else
			writeOut(
				`The import of ${gone.folder} is abandoned: ${gone.server === 'abandoned' ? 'its folder is deleted on the server' : 'its folder was gone from the server already'}${gone.removed === null ? '' : `, and ${gone.removed} is removed`}.`,
			);
		return EXIT.ok;
	}
	let report: Awaited<ReturnType<typeof importGit>>;
	try {
		report = await importGit({
			source,
			resume,
			branch: typeof options.branch === 'string' ? options.branch : undefined,
			name: typeof options.name === 'string' ? options.name : undefined,
			replaceOriginal: options['replace-original'] === true,
			account: signedIn.data,
			root: homeRoot(),
		});
	} catch (cause) {
		return fail(message(cause), json);
	}
	if (json) writeJson({ import: report });
	else {
		writeOut(
			`${report.path}: ${count(report.changes, 'change')} from ${count(report.commits, 'commit')} of ${report.branch}${report.resumed > 0 ? ` (${report.resumed} landed before this run)` : ''}, ${count(report.marks.length, 'mark')}; synced as folder ${report.folder}`,
		);
		for (const warning of report.warnings) writeErr(warning);
		if (report.original !== null)
			writeErr(
				`The original is at ${report.original.movedTo}, its .git within it; ${report.original.link} now links to ${report.path}.`,
			);
	}
	return EXIT.ok;
}

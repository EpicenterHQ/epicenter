/**
 * `epicenter check [<app>]`: read every data key an app declares, or every
 * app's, and report the records that do not fit their declaration, so a
 * person or an agent can repair them. `--json` also counts each key's
 * problems by kind, so one declaration that is too narrow reads as one cause
 * rather than as many broken files. It reads the app's folder and writes
 * nothing.
 */

import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { type CheckedKey, checkData } from '../data-check.ts';
import { ActionError, type Answer, Err, Ok } from '../index.ts';
import {
	discoverAll,
	type LoadedApp,
	loadHomeApp,
	localProblem,
} from './home.ts';
import type { EpicenterRoot } from './root.ts';

/** An app with a problem outside its records: it did not load, a read failed, or its `local/` could reach Git. */
type Unchecked = { entry: string; folder: string; problems: string[] };

/** Every data key of `loaded`, read from its folder; nothing is written. */
async function checkApp({ app, realPath }: LoadedApp) {
	return app.data ? checkData(realPath, app.data) : {};
}

/** The report as a person reads it: each app, then each data key. */
function render(
	apps: Record<string, Record<string, CheckedKey>>,
	unchecked: Unchecked[],
) {
	const lines: string[] = [];
	for (const [app, keys] of Object.entries(apps)) {
		if (lines.length) lines.push('');
		lines.push(app);
		if (!Object.keys(keys).length) lines.push('  no data keys');
		for (const [name, each] of Object.entries(keys)) {
			const status =
				each.single && each.withProblems === 0
					? 'fits'
					: `${each.files} ${each.files === 1 ? 'file' : 'files'}, ${each.withProblems || 'none'} with problems`;
			lines.push(`  ${name}  ${status}`);
			for (const record of each.records)
				lines.push(
					`    ${/\p{Cc}/u.test(record.path) ? JSON.stringify(record.path) : record.path}`,
					...record.problems.map((problem) => `      ${problem}`),
				);
		}
	}
	if (unchecked.length) {
		if (lines.length) lines.push('');
		lines.push('Problems:');
		for (const app of unchecked)
			lines.push(
				`  ${app.entry}`,
				`    ${app.folder}`,
				...app.problems.map((problem) => `    ${problem}`),
			);
	}
	return lines.length
		? lines.join('\n')
		: 'No apps yet. An app is apps/<name>/code/epicenter.ts';
}

/**
 * Check one app, or every app when none is named. The report is what it
 * found: the records with problems, and the apps with problems outside them.
 * A clean report is `Ok`; any problem makes it `Problems`, carrying the same
 * report. A named app that does not load is `NotStarted`.
 */
export async function checkCommand(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string | undefined,
	json: boolean,
): Promise<Answer> {
	const folder = (app: string) => join(root.folder, 'apps', app);
	let loaded: LoadedApp[];
	const unchecked: Unchecked[] = [];
	if (name === undefined) {
		const found = await discoverAll(root);
		loaded = found.apps;
		for (const { name, problems } of found.problems)
			unchecked.push({ entry: name, folder: folder(name), problems });
	} else {
		const { data: one, error } = await loadHomeApp(root, name);
		if (error) return Err(error);
		loaded = [one];
		const local = await localProblem(one);
		if (local)
			unchecked.push({ entry: name, folder: folder(name), problems: [local] });
	}
	const apps: Record<string, Record<string, CheckedKey>> = {};
	for (const each of loaded) {
		try {
			apps[each.name] = await checkApp(each);
		} catch (error) {
			unchecked.push({
				entry: each.name,
				folder: folder(each.name),
				problems: [extractErrorMessage(error)],
			});
		}
	}
	const report = json ? { apps, problems: unchecked } : render(apps, unchecked);
	const files = Object.values(apps)
		.flatMap((keys) => Object.values(keys))
		.reduce((sum, each) => sum + each.withProblems, 0);
	if (!files && !unchecked.length) return Ok(report);
	const counted = (count: number, one: string, many: string) =>
		count ? [`${count} ${count === 1 ? one : many}`] : [];
	return ActionError.Problems({
		message: [
			...counted(files, 'file has problems', 'files have problems'),
			...counted(unchecked.length, 'app has problems', 'apps have problems'),
		].join('; '),
		report,
	});
}

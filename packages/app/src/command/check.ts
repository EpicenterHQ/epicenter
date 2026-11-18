/**
 * `epicenter check [<app>]`: read every data key an app declares, or every
 * app's, and report the records that do not fit their declaration, so a
 * person or an agent can repair them. `--json` also counts each key's
 * problems by kind, so one declaration that is too narrow reads as one cause
 * rather than as many broken files. It reads the app's folder and writes
 * nothing.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { ActionError, type Answer, checkData, Err, Ok } from '../index.ts';
import { parseWords } from './commands.ts';
import {
	discoverAll,
	loadHomeApp,
	localProblem,
	type Runnable,
} from './home.ts';

/** One data key as the check found it. */
type Checked = {
	/** True for a one-file key. */
	single: boolean;
	/** The key's file, or its folder ending in `/`. */
	path: string;
	/** How many files it matched. */
	files: number;
	/** How many of them have problems. */
	withProblems: number;
	/** Each kind of problem and how many files have it, most frequent first. */
	kinds: { kind: string; count: number }[];
	/** Each file with problems, by path, with its problem lines. */
	records: { path: string; problems: string[] }[];
};

/** An app with a problem outside its records: it did not load, a read failed, or its `local/` could reach Git. */
type Unchecked = { entry: string; folder: string; problems: string[] };

/** Every data key of `located`, read from its folder; nothing is written. */
async function checkApp(located: Runnable) {
	const { data } = located.app;
	if (!data) return {};
	const found = await checkData(located.realPath, data);
	const checked: Record<string, Checked> = {};
	for (const [key, each] of Object.entries(found))
		checked[key] = {
			...each,
			records: each.records.map(({ path, problems }) => ({
				path,
				problems: problems.map(({ line }) => line),
			})),
		};
	return checked;
}

/** The report as a person reads it: each app, then each data key. */
function render(
	apps: Record<string, Record<string, Checked>>,
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
	words: string[],
	json: boolean,
): Promise<Answer> {
	const { data: given, error: misused } = parseWords('check', words, [0, 1]);
	if (misused) return Err(misused);
	const [name] = given;
	let runnable: Runnable[];
	const unchecked: Unchecked[] = [];
	if (name === undefined) {
		const found = await discoverAll();
		runnable = found.apps;
		for (const { entry, folder, problems } of found.problems)
			unchecked.push({ entry, folder, problems });
	} else {
		const { data: one, error } = await loadHomeApp(name);
		if (error) return Err(error);
		runnable = [one];
		const local = await localProblem(one.entry, one.realPath);
		if (local)
			unchecked.push({
				entry: one.entry,
				folder: one.folder,
				problems: [local],
			});
	}
	const apps: Record<string, Record<string, Checked>> = {};
	for (const located of runnable) {
		try {
			apps[located.entry] = await checkApp(located);
		} catch (error) {
			const { entry, folder } = located;
			unchecked.push({ entry, folder, problems: [extractErrorMessage(error)] });
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

/**
 * `epicenter check [<app>]`: read every data key an app declares, or every
 * app's, and report the records that do not fit their declaration, so a
 * person or an agent can repair them. `--json` also counts each key's
 * problems by kind, so one declaration that is too narrow reads as one cause
 * rather than as many broken files. It reads the app's folder and writes
 * nothing.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { type CheckedKey, checkData, strayData } from '../data-check.ts';
import { ActionError, type Answer, isName, Ok } from '../index.ts';
import { loadApps } from './apps.ts';
import { type AppProblems, appProblems, unknownApp } from './protocol.ts';
import { problemLines, withFolders } from './report.ts';
import type { EpicenterRoot } from './root.ts';

/** The report as a person reads it: each app, then each data key. */
function render(
	root: Pick<EpicenterRoot, 'folder'>,
	apps: Record<string, Record<string, CheckedKey>>,
	unchecked: AppProblems[],
) {
	const lines: string[] = [];
	for (const [app, keys] of Object.entries(apps)) {
		if (lines.length) lines.push('');
		lines.push(app);
		if (!Object.keys(keys).length) lines.push('  no data keys');
		for (const [name, each] of Object.entries(keys)) {
			const status = `${each.files} ${each.files === 1 ? 'file' : 'files'}, ${each.withProblems || 'none'} with problems`;
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
		lines.push(...problemLines(root, unchecked));
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
	const entries = [...(await loadApps(root)).values()].filter(
		(entry) => name === undefined || entry.name === name,
	);
	if (name !== undefined) {
		const [one] = entries;
		if (!one || !isName(name)) return unknownApp(name);
		if (!one.app) return appProblems(name, one.problems);
	}
	const apps: Record<string, Record<string, CheckedKey>> = {};
	const unchecked: AppProblems[] = [];
	for (const { name, folder, app, problems } of entries) {
		const found = [...problems];
		if (app)
			try {
				apps[name] = app.data ? await checkData(folder, app.data) : {};
				found.push(...(await strayData(folder, Object.keys(app.data ?? {}))));
			} catch (error) {
				found.push(extractErrorMessage(error));
			}
		if (found.length) unchecked.push({ entry: name, problems: found });
	}
	const report = json
		? { apps, problems: withFolders(root, unchecked) }
		: render(root, apps, unchecked);
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

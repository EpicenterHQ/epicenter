/**
 * `epicenter check [<app>]`: read every collection an app declares, or every
 * app's, and report the records that do not fit their declaration, so a
 * person or an agent can repair them. Each collection leads with its problems
 * counted by kind, so one declaration that is too narrow reads as one cause
 * rather than as many broken files. The read runs in a run of the app's
 * folder, as an action's does, and writes nothing.
 */
import { inRun } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { CliError } from './errors.ts';
import { discoverAll, loadHomeApp, type Runnable } from './home.ts';
import { fail, writeJson, writeOut } from './output.ts';

/** One collection as the check found it. */
type Checked = {
	/** The collection's path template. */
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

/** An app that could not be checked: it did not load, or a read failed. */
type Unchecked = { entry: string; folder: string; problems: string[] };

/** Every collection of `located`, read in a read-only run of its folder. */
async function checkApp(located: Runnable) {
	const checked: Record<string, Checked> = {};
	await inRun(located.context, async () => {
		for (const [name, collection] of Object.entries(located.app.collections)) {
			const { files, records } = await collection.check();
			const counts = new Map<string, number>();
			for (const { problems } of records)
				for (const { kind } of problems)
					counts.set(kind, (counts.get(kind) ?? 0) + 1);
			checked[name] = {
				path: collection.path,
				files,
				withProblems: records.length,
				kinds: [...counts]
					.map(([kind, count]) => ({ kind, count }))
					.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
				records: records.map(({ path, problems }) => ({
					path,
					problems: problems.map(({ line }) => line),
				})),
			};
		}
	});
	return checked;
}

/** The report as a person reads it: each app, then each collection. */
function render(
	apps: Record<string, Record<string, Checked>>,
	unchecked: Unchecked[],
) {
	const lines: string[] = [];
	for (const [app, collections] of Object.entries(apps)) {
		if (lines.length) lines.push('');
		lines.push(app);
		if (!Object.keys(collections).length) lines.push('  no collections');
		for (const [name, each] of Object.entries(collections)) {
			lines.push(`  ${name}  ${each.path}`);
			if (!each.files) {
				lines.push('    0 files');
				continue;
			}
			lines.push(
				`    ${each.files} ${each.files === 1 ? 'file' : 'files'}, ${each.withProblems || 'none'} with problems`,
			);
			const width = Math.max(
				...each.kinds.map(({ count }) => String(count).length),
			);
			for (const { kind, count } of each.kinds)
				lines.push(`    ${String(count).padStart(width)}  ${kind}`);
			for (const record of each.records)
				lines.push(
					`    ${record.path}`,
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
		: 'No apps yet. Run: epicenter new <name>';
}

/** Check one app, or every app when none is named; exit 1 when any record has a problem or any app could not be checked. */
export async function checkCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 1]);
	if (!given) return fail(misuse('check'), json);
	const name = given.positionals[0];
	let runnable: Runnable[];
	const unchecked: Unchecked[] = [];
	if (name === undefined) {
		const found = await discoverAll();
		runnable = found.apps;
		for (const { entry, folder, problems } of found.problems)
			unchecked.push({ entry, folder, problems });
	} else {
		const { data: one, error } = await loadHomeApp(name);
		if (error) return fail(error, json);
		if (!one.ok)
			return fail(
				CliError.AppProblems({ app: name, problems: one.problems }).error,
				json,
			);
		runnable = [one];
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
	if (json) writeJson({ apps, problems: unchecked });
	else writeOut(render(apps, unchecked));
	const anyProblem = Object.values(apps).some((collections) =>
		Object.values(collections).some((each) => each.withProblems > 0),
	);
	return anyProblem || unchecked.length ? 1 : 0;
}

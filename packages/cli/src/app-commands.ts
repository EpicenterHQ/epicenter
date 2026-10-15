/**
 * `epicenter app list | install | update | remove` (ADR-0558): what
 * `installed-apps.ts` does, as text for a person or JSON for a program.
 *
 * With `--json`, `app list` and `app remove` print one JSON value.
 * `app install` and `app update` print NDJSON: `{"progress": "<sentence>"}`
 * while they work, then one result line, `{"app": <InstalledApp>}`, or
 * `{"error": "<message>"}` when they cannot finish. They exit 0 when the app
 * is built at its commit, 1 when it waits for approval (the result carries
 * its review), and 2 on an error. The desktop shell runs these and pipes each
 * line to the Folders window.
 */

import { resolveAppPaths } from './app-paths.ts';
import {
	type InstalledApp,
	install,
	listInstalled,
	listRepository,
	type Progress,
	remove,
	update,
} from './installed-apps.ts';
import { EXIT, writeErr, writeJson, writeOut } from './output.ts';

type Options = Record<string, string | true>;

function progress(json: boolean): Progress {
	return (message) => {
		if (json) writeJson({ progress: message });
		else writeErr(message);
	};
}

function stateText(app: InstalledApp) {
	switch (app.state.kind) {
		case 'ready':
			return 'ready';
		case 'unbuilt':
			return 'builds when opened';
		case 'needsApproval':
			return 'waiting for approval';
		case 'broken':
			return `broken: ${app.state.problem}`;
	}
}

/** The result of `app install` or `app update`, and its exit code. */
function settled(app: InstalledApp, json: boolean) {
	const waiting = app.state.kind === 'needsApproval';
	if (json) writeJson({ app });
	else if (app.state.kind === 'needsApproval') {
		const { review } = app.state;
		writeOut(
			[
				`${app.title} (${app.id}) is waiting for approval at commit ${app.commit}.`,
				'',
				review.from === null
					? 'Commits:'
					: `New commits since ${review.from.slice(0, 12)} was approved:`,
				review.log || '(none)',
				...(review.from === null
					? []
					: ['', 'Changed files:', review.diffStat || '(none)']),
				'',
				review.statement,
				`To approve it, run: epicenter app update ${app.id} --approve`,
			].join('\n'),
		);
	} else
		writeOut(
			`${app.title} (${app.id}) is ${stateText(app)} at commit ${app.commit.slice(0, 12)}.`,
		);
	return waiting ? EXIT.finding : EXIT.ok;
}

export async function appList(options: Options, json: boolean) {
	const paths = resolveAppPaths();
	const repository = options.repository;
	if (typeof repository === 'string') {
		const apps = await listRepository(paths, repository);
		if (json) writeJson({ source: repository, apps });
		else if (apps.length === 0)
			writeErr('This repository has no folder with an epicenter.app.json.');
		else
			for (const app of apps)
				writeOut(
					[
						app.folder || '.',
						app.problem ?? `${app.title} (${app.id})`,
						...(app.installed ? ['installed'] : []),
					].join('\t'),
				);
		return EXIT.ok;
	}
	const apps = await listInstalled(paths);
	if (json) writeJson({ apps });
	else
		for (const app of apps)
			writeOut(
				[app.id, app.title, stateText(app), app.folder || '.', app.source].join(
					'\t',
				),
			);
	return EXIT.ok;
}

export async function appInstall(
	source: string,
	options: Options,
	json: boolean,
) {
	const folder = typeof options.folder === 'string' ? options.folder : '';
	const app = await install(resolveAppPaths(), source, folder, {
		approve: options.approve === true,
		onProgress: progress(json),
	});
	return settled(app, json);
}

export async function appUpdate(id: string, options: Options, json: boolean) {
	const app = await update(resolveAppPaths(), id, {
		approve: options.approve === true,
		commit: typeof options.commit === 'string' ? options.commit : undefined,
		onProgress: progress(json),
	});
	return settled(app, json);
}

export async function appRemove(id: string, json: boolean) {
	await remove(resolveAppPaths(), id);
	if (json) writeJson({ removed: id });
	else writeOut(`Removed ${id}.`);
	return EXIT.ok;
}

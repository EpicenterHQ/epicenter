/**
 * The `epicenter` command. It runs no app code: it finds its home by walking
 * up to the marker, and asks that home's serve. `epicenter serve` is the
 * process that imports the home's `epicenter.ts`.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { ActionError } from '../errors.ts';
import { isName } from '../name.ts';
import type { Answer } from '../result.ts';
import { findHome, type Home } from './home.ts';
import { presentAnswer, writeErr } from './output.ts';
import type { AppListing, Listing } from './protocol.ts';
import { callAction, fetchListing } from './send.ts';

const HELP = `epicenter                          every app in this home
epicenter <app>                    what an app can do
epicenter <app> <action> [<input>] run an action; the input is one JSON object
epicenter serve                    run the home: import epicenter.ts and listen
epicenter --version

The home is the nearest folder at or above this one whose package.json has
an "epicenter" key, such as "epicenter": { "port": 4747 }. serve starts in
that folder and listens on 127.0.0.1 at that port; every other command asks
it, and runs no app code itself. Restart serve after changing code.
Exit codes: 0 done, 1 failed or may have run, 2 did not run.`;

const usage = (message: string, next = 'epicenter --help') =>
	ActionError.NotStarted({ message, next });

/** Names in a column, each followed by its description. */
function table(rows: [string, string][]) {
	const width = Math.max(0, ...rows.map(([name]) => name.length));
	return rows.map(([name, text]) => `${name.padEnd(width)}  ${text}`);
}

/** What bare `epicenter` prints. */
function homeText(listing: Listing, home: Home) {
	const lines = [`Home: ${home.folder} (epicenter ${listing.version})`, ''];
	if (listing.problem) return [...lines, listing.problem].join('\n');
	if (!listing.apps.length)
		return [
			...lines,
			'No apps yet: epicenter.ts passes none to defineEpicenter.',
		].join('\n');
	return [
		...lines,
		...table(listing.apps.map((app) => [app.name, app.description])),
		'',
		'Run: epicenter <app>',
	].join('\n');
}

/** What `epicenter <app>` prints: each action, and the keys its input takes. */
function appText({ name, description, actions }: AppListing) {
	const keys = ({
		properties,
		required,
	}: AppListing['actions'][number]['input']) =>
		Object.keys(properties)
			.map((key) => (required.includes(key) ? key : `${key}?`))
			.join(', ');
	return [
		`${name}: ${description}`,
		'',
		...table(
			actions.map((action) => {
				const input = keys(action.input);
				return [
					action.name,
					input ? `${action.description} (${input})` : action.description,
				];
			}),
		),
		'',
		`Run: epicenter ${name} <action> '{"key":"value"}'`,
	].join('\n');
}

/** The answer for `words`, which the caller presents. */
async function answer(words: string[]): Promise<Answer | undefined> {
	const [app, action, input, ...extra] = words;
	if (app === 'serve') {
		if (action !== undefined) return usage('Usage: epicenter serve');
		const { data: home, error } = findHome();
		if (error) return Err(error);
		const { serveHome } = await import('./serve.ts');
		return serveHome(home);
	}
	if (app !== undefined && !isName(app))
		return usage(`${JSON.stringify(app)} is not an app's name`, 'epicenter');
	if (action !== undefined && !isName(action))
		return usage(
			`Name an action of ${app} before its input`,
			`epicenter ${app}`,
		);
	if (extra.length)
		return usage(
			'The input is one argument, a JSON object; quote it whole',
			`epicenter ${app}`,
		);
	const { data: home, error } = findHome();
	if (error) return Err(error);
	if (app !== undefined && action !== undefined)
		// Each update is one line of JSON on stderr, as it arrives.
		return callAction(home, app, action, input ?? '{}', (update) =>
			writeErr(JSON.stringify(update)),
		);
	const { data: listing, error: unlisted } = await fetchListing(home);
	if (unlisted) return Err(unlisted);
	if (app === undefined) return Ok(homeText(listing, home));
	const found = listing.apps.find((each) => each.name === app);
	if (!found)
		return ActionError.NotStarted({
			message: `There is no app "${app}"`,
			next: 'epicenter',
		});
	return Ok(appText(found));
}

/** Run the command and return its exit code, so the entry point lets stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h'))
		return presentAnswer(Ok(HELP));
	if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V'))
		return presentAnswer(Ok(`epicenter ${packageJson.version}`));
	const flag = argv.find((word) => word.startsWith('-'));
	if (flag)
		return presentAnswer(
			usage(`${flag} is not an option; the options are --help and --version`),
		);
	let answered: Answer | undefined;
	try {
		answered = await answer(argv);
	} catch (cause) {
		answered = ActionError.NotStarted({ message: extractErrorMessage(cause) });
	}
	return answered === undefined ? 0 : presentAnswer(answered);
}

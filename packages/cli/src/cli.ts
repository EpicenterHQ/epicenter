/**
 * The epicenter command runs apps from the home or an explicit folder path
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its returned exit code follows whether run started (ADR-0842).
 */
import { isPositional } from '@epicenter/app';
import packageJson from '../package.json' with { type: 'json' };
import {
	discoverAll,
	isFolderPath,
	type Located,
	loadFolder,
	loadHomeApp,
	Refusal,
} from './home.ts';
import {
	checkInput,
	flagOf,
	inputFromArgs,
	matchAction,
	usageLine,
} from './input.ts';
import {
	actionHelp,
	actionListing,
	homeListing,
	oneAppListing,
} from './listing.ts';
import { mcpCommand } from './mcp.ts';
import { fail, writeJson, writeOut } from './output.ts';
import { runAction } from './run.ts';

const HELP = `epicenter [--json]
epicenter <app> [--json]
epicenter <app> <action words> [<positional>] [--flags] [--json]
epicenter <path> <action words> [<positional>] [--flags] [--json]
epicenter mcp [<app>…]
epicenter new <name> | add <source> | update | sync | serve | open
epicenter help [<app> [<action words>]]
epicenter --version

Global flags come after the action words: --json, --help (-h).
Exit codes: 0 success, 1 finding, 2 did not run, 3 action started and threw.
EPICENTER_HOME: app home (default ~/Epicenter).
EPICENTER_CACHE_HOME: device cache (default ~/Library/Caches/so.epicenter.apps).
EPICENTER_TEST_SECRETS: JSON service stores held in memory for this process.
Run epicenter for your apps.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	if (argv[0] === 'help') argv = [...argv.slice(1), '--help'];
	let leading = 0;
	while (GLOBALS.has(argv[leading] ?? '')) leading++;
	const tokens: string[] = [];
	let json = false;
	let help = false;
	let version = false;
	let literal = false;
	for (const token of argv) {
		if (literal) tokens.push(token);
		else if (token === '--') {
			literal = true;
			tokens.push(token);
		} else if (token === '--json') json = true;
		else if (token === '--help' || token === '-h') help = true;
		else if (
			(token === '--version' || token === '-V') &&
			leading === argv.length
		)
			version = true;
		else tokens.push(token);
	}
	if (leading > 0 && leading < argv.length) {
		return fail(
			{
				code: 'usage',
				message: 'Global flags come after the action words',
				next: `epicenter ${[...argv.slice(leading), ...argv.slice(0, leading)].join(' ')}`,
			},
			json,
		);
	}
	const print = (value: unknown) => {
		if (json) writeJson(value);
		else writeOut(String(value));
	};
	try {
		if (!tokens.length) {
			if (version)
				print(
					json
						? { version: packageJson.version }
						: `epicenter ${packageJson.version}`,
				);
			else if (help) print(HELP);
			else print(homeListing(await discoverAll(), json));
			return 0;
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (['new', 'add', 'update', 'sync', 'serve', 'open'].includes(name))
			return fail(
				{ code: 'usage', message: `epicenter ${name} is not built yet` },
				json,
			);
		if (name === 'mcp') {
			if (help) {
				print('epicenter mcp [<app>…]');
				return 0;
			}
			if (json)
				return fail(
					{
						code: 'usage',
						message: 'MCP uses stdout for protocol; --json does not apply',
					},
					json,
				);
			return mcpCommand(words);
		}
		let located: Located;
		try {
			located = await (isFolderPath(name)
				? loadFolder(name, words)
				: loadHomeApp(name));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(
				{
					code: 'usage',
					message,
					next: error instanceof Refusal ? error.next : undefined,
				},
				json,
			);
		}
		if (located.problems.length || !located.app)
			return fail(
				{ code: 'usage', message: `${name}: ${located.problems.join('; ')}` },
				json,
			);
		if (!words.length) {
			print(oneAppListing(located, json));
			return 0;
		}
		const app = located.app;
		const matched = matchAction(app, words);
		const action = matched && app.actions[matched.key];
		if (!matched || !action)
			return fail(
				{
					code: 'usage',
					message: `Unknown action ${words.join(' ')}.\n${Object.entries(
						app.actions,
					)
						.map(([key, action]) => usageLine(name, key, action))
						.join('\n')}`,
					next: `epicenter ${name}`,
				},
				json,
			);
		if (help) {
			print(
				json
					? actionListing(located.name, matched.key, action)
					: actionHelp(name, matched.key, action),
			);
			return 0;
		}
		const next = `epicenter ${name} ${matched.key} --help`;
		const parsed = inputFromArgs(action, matched.rest);
		if ('error' in parsed)
			return fail({ code: 'usage', message: parsed.error, next }, json);
		const checked = checkInput(action, parsed.input, (key) => {
			const schema = action.input[key];
			return schema && isPositional(schema) ? `<${key}>` : `--${flagOf(key)}`;
		});
		if ('error' in checked)
			return fail({ code: 'usage', message: checked.error, next }, json);
		const result = await runAction(located, matched.key, checked.input);
		if (!result.ok)
			return fail({ code: 'failed', message: result.error }, json);
		if (json) writeJson(result.value ?? null);
		else if (typeof result.value === 'string') writeOut(result.value);
		else if (result.value !== undefined)
			writeOut(JSON.stringify(result.value, null, 2));
		return 0;
	} catch (error) {
		return fail(
			{
				code: 'usage',
				message: error instanceof Error ? error.message : String(error),
			},
			json,
		);
	}
}

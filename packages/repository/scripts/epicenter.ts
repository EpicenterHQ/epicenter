/**
 * The folder commands over this package's engine (`src/bun/folder-commands.ts`):
 *
 *   bun run epicenter -- sync <dir> [--join <owner>/<name> --server <url>] [--token <t>] [--agent <name>] [--once] [--json]
 *   bun run epicenter -- commit <dir> -m <message> [--token <t>] [--json]
 *
 * The token is `--token` or `EPICENTER_TOKEN`. The desktop replaces
 * `packages/cli`'s Git commands with these in one change (see the README).
 */
import { parseArgs } from 'node:util';
import { commit, type Line, plain, sync } from '../src/bun/folder-commands.js';

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		join: { type: 'string' },
		server: { type: 'string' },
		token: { type: 'string' },
		agent: { type: 'string' },
		once: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
		message: { type: 'string', short: 'm' },
	},
});
const print = (line: Line) => console.log(values.json ? JSON.stringify(line) : plain(line));
const [command, dir] = positionals;
const usage = () => {
	console.error('Usage: epicenter sync <dir> [--join <owner>/<name> --server <url>] [--token <t>] [--agent <name>] [--once] [--json]\n       epicenter commit <dir> -m <message> [--json]');
	process.exit(1);
};
if (dir === undefined) usage();
const folder = dir as string;
if ((values.join === undefined) !== (values.server === undefined)) usage();
const options = {
	dir: folder,
	...(values.join !== undefined && values.server !== undefined ? { join: { repository: values.join, server: values.server } } : {}),
	...(values.token === undefined ? {} : { token: values.token }),
	...(values.agent === undefined ? {} : { agent: values.agent }),
	// A periodic scan finds what a silently dropped event hid: a warm scan of 100,000 files took 1.8 s, so every 5 minutes is about 0.6% of one core (the phase 9 report).
	scanEvery: 5 * 60_000,
};
let code: number;
if (command === 'sync') {
	const stop = new Promise<void>((resolve) => {
		process.once('SIGINT', () => resolve());
		process.once('SIGTERM', () => resolve());
	});
	code = await sync({ ...options, once: values.once, stop }, print);
} else if (command === 'commit') {
	if (values.message === undefined || values.message === '') usage();
	code = await commit({ ...options, message: values.message as string }, print);
} else code = (usage(), 1);
process.exit(code);

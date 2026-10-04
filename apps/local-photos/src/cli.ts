import { importTakeout } from './import/takeout.js';
import { photosDbPath, resolveDataDir } from './paths.js';
import { queryPhotos } from './photos/query.js';
import { resolvePhotos } from './photos/resolve.js';
import { readPhotosStatus } from './photos/status.js';

export const VERSION = '0.0.1';

const HELP = `local-photos: own a private local photo archive; imports add evidence.

Usage:
  local-photos import <directory> [--incremental] [--data-dir <path>]
  local-photos status [--data-dir <path>]
  local-photos query "<sql>" [--data-dir <path>]
  local-photos resolve [--data-dir <path>]

Commands:
  import   Import an extracted Google Takeout directory as one immutable batch.
  status   Show archive and import counts.
  query    Run bounded, read-only SQL over the archive.
  resolve  Recompute normalized asset metadata from preserved claims.

Options:
  --incremental       Tag this Takeout as an incremental export.
  --data-dir <path>   Archive home (or LOCAL_PHOTOS_DIR).
  -h, --help          Show this help.
  -v, --version       Show the version.

Imports are additive. A later import that omits a photo never deletes it.
Zip ingestion is not in this first checkpoint; extract the archive before import.
`;

export type ParsedArgs = {
	command: string;
	positionals: string[];
	dataDir?: string;
	incremental: boolean;
	help: boolean;
	version: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: '',
		positionals: [],
		incremental: false,
		help: false,
		version: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] as string;
		if (!token.startsWith('-')) {
			if (!args.command) args.command = token;
			else args.positionals.push(token);
			continue;
		}

		switch (token) {
			case '--incremental':
				args.incremental = true;
				break;
			case '--data-dir': {
				const value = argv[index + 1];
				if (!value) throw new Error('--data-dir needs a value');
				args.dataDir = value;
				index += 1;
				break;
			}
			case '-h':
			case '--help':
				args.help = true;
				break;
			case '-v':
			case '--version':
				args.version = true;
				break;
			default:
				throw new Error(`Unknown option: ${token}`);
		}
	}

	return args;
}

export async function runCli(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.version) {
		console.log(VERSION);
		return 0;
	}
	if (args.help || !args.command) {
		console.log(HELP);
		return args.help ? 0 : 1;
	}

	const dataDir = resolveDataDir(args.dataDir);
	switch (args.command) {
		case 'import': {
			const path = args.positionals[0];
			if (!path || args.positionals.length !== 1) {
				throw new Error('Usage: local-photos import <directory>');
			}
			const result = await importTakeout({
				dataDir,
				path,
				incremental: args.incremental,
			});
			console.log(JSON.stringify(result, null, 2));
			return 0;
		}
		case 'status':
			console.log(JSON.stringify(readPhotosStatus(dataDir), null, 2));
			return 0;
		case 'query': {
			const sql = args.positionals.join(' ').trim();
			if (!sql) throw new Error('Usage: local-photos query "<sql>"');
			console.log(
				JSON.stringify(
					queryPhotos({ dbPath: photosDbPath(dataDir), sql }),
					null,
					2,
				),
			);
			return 0;
		}
		case 'resolve':
			console.log(
				JSON.stringify({
					assetsResolved: resolvePhotos(photosDbPath(dataDir)),
				}),
			);
			return 0;
		default:
			throw new Error(`Unknown command: ${args.command}`);
	}
}

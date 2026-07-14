import yargs from 'yargs';
import { authCommand } from './commands/auth.js';
import { blobsCommand } from './commands/blobs.js';
import { downCommand } from './commands/down.js';
import { initCommand } from './commands/init.js';
import { logsCommand } from './commands/logs.js';
import { matterCommand } from './commands/matter.js';
import { statusCommand } from './commands/status.js';
import { tablesCommand } from './commands/tables.js';
import { upCommand } from './commands/up.js';

/**
 * Create the Epicenter CLI instance.
 *
 * Operate Epicenter roots from the shell.
 *
 *   - `up` / `down` / `status` / `logs`: run and inspect the headless
 *     sync/materialization watcher (ADR-0112)
 *   - `auth`: manage the local machine auth session (pre-workspace)
 *   - `blobs`: archive a file/URL into the content-addressed cloud blob store
 *   - `init`: scaffold epicenter.config.ts (explicit root creation)
 *   - `matter`: lint a folder of typed markdown (disk is the source; SQLite is a projection)
 *
 * Workspace actions remain an in-process app/tool boundary. The CLI no longer
 * exposes a generic daemon action server.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(upCommand)
				.command(downCommand)
				.command(statusCommand)
				.command(logsCommand)
				.command(authCommand)
				.command(blobsCommand)
				.command(initCommand)
				.command(matterCommand)
				.command(tablesCommand)
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}

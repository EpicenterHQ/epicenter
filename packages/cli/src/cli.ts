import yargs from 'yargs';
import { authCommand } from './commands/auth.js';
import { blobsCommand } from './commands/blobs.js';
import { matterCommand } from './commands/matter.js';
import { tablesCommand } from './commands/tables.js';

/**
 * Create the Epicenter CLI instance.
 *
 * Operate explicit Epicenter cloud and data workflows from the shell.
 *
 *   - `auth`: manage the local machine auth session (pre-workspace)
 *   - `blobs`: archive a file/URL into the content-addressed cloud blob store
 *   - `matter`: lint a folder of typed markdown (disk is the source; SQLite is a projection)
 *   - `tables`: review and apply portable SQLite workspace edits
 *
 * Application sync, status, and foreground watch commands belong to each
 * application's CLI. This package owns no generic process lifecycle.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(authCommand)
				.command(blobsCommand)
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

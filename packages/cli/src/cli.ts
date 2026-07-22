import yargs from 'yargs';
import { authCommand } from './commands/auth.js';
import { blobsCommand } from './commands/blobs.js';
import { matterCommand } from './commands/matter.js';

/**
 * Create the Epicenter CLI instance.
 *
 * Operate Epicenter's account-level and file-backed tools from the shell.
 *
 *   - `auth`: manage the local machine auth session
 *   - `blobs`: upload and retrieve bytes in the remote blob store
 *   - `matter`: lint a folder of typed markdown (disk is the source; SQLite is a projection)
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(authCommand)
				.command(blobsCommand)
				.command(matterCommand)
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}

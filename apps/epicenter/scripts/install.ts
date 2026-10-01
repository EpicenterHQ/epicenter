import { isAbsolute } from 'node:path';
import { epicenterDataRoot } from '@epicenter/constants/app-data';
import { installApplication } from '../src/app-installation.ts';
import { RESERVED_APPLICATION_IDS } from '../src/applications.ts';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
	process.stdout.write(
		'Usage: bun run --cwd apps/epicenter app:install -- <release> [--data-dir <path>]\n',
	);
	process.exit(0);
}
const releaseRoot = args.shift();
if (releaseRoot === undefined || releaseRoot.startsWith('--')) {
	throw new Error(
		'Usage: bun run --cwd apps/epicenter app:install -- <release> [--data-dir <path>]',
	);
}

let dataRootOverride: string | undefined;
while (args.length > 0) {
	const argument = args.shift();
	if (argument !== '--data-dir') {
		throw new Error(`Unknown argument: ${argument}`);
	}
	const override = args.shift();
	if (override === undefined) throw new Error('--data-dir requires a path.');
	if (!isAbsolute(override))
		throw new Error('--data-dir must be an absolute path.');
	dataRootOverride = override;
}

const dataRoot =
	dataRootOverride === undefined ? epicenterDataRoot() : dataRootOverride;

const installed = await installApplication({
	releaseRoot,
	dataRoot,
	reservedIds: RESERVED_APPLICATION_IDS,
});
process.stdout.write(
	`Installed ${installed.manifest.title} (${installed.manifest.id}) at ${installed.appRoot}\n`,
);

/**
 * The `@epicenter/app` an app's own tools resolve: its UI's build, an editor's
 * types, and `bun test` (ADR-0873, ADR-0880). `epicenter` supplies the package
 * to every `epicenter.ts` it runs, and links `node_modules/@epicenter/app` in
 * an app's folder to the same copy, so no app lists it and a UI's client
 * always speaks the `serve` that answers it.
 *
 * Run from source, the copy is this repository's `packages/app`. A compiled
 * `epicenter` carries the package, its source, `/client`, types and the
 * packages they import, as the module `epicenter:app-package`, which
 * `scripts/compile.ts` makes; it writes them once per build to a folder of
 * its own, `$XDG_DATA_HOME/epicenter/app/<version>-<hash>` (by default under
 * `~/.local/share`), and links there.
 */
import {
	mkdir,
	mkdtemp,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMPILED } from './commands.ts';

/** What `scripts/compile.ts` puts in the binary: the package's files under one key per build. */
export type AppPackageFiles = {
	/** `<version>-<hash>`, which names the folder they are written to. */
	key: string;
	/** Each file's path inside the package folder, and its bytes in base64. */
	files: [path: string, base64: string][];
};

/** Where a compiled `epicenter` writes the packages it carries. */
function dataHome() {
	return join(
		process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
		'epicenter',
		'app',
	);
}

/** Write `carried` to its own folder unless it is there, whole, already; answer the folder. */
export async function writeAppPackage(
	carried: AppPackageFiles,
	home = dataHome(),
): Promise<string> {
	const folder = join(home, carried.key);
	try {
		await stat(join(folder, 'package.json'));
		return folder;
	} catch {}
	await mkdir(home, { recursive: true });
	const staging = await mkdtemp(join(home, `.${carried.key}-`));
	try {
		for (const [path, base64] of carried.files) {
			const file = join(staging, path);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, Buffer.from(base64, 'base64'));
		}
		try {
			await rename(staging, folder);
		} catch (error) {
			// Another `epicenter` wrote the same build first.
			if (!(await stat(join(folder, 'package.json')).catch(() => undefined)))
				throw error;
		}
		return folder;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

let found: Promise<string> | undefined;

/** The folder of the `@epicenter/app` this command runs, written out first when compiled. */
export function appPackageFolder(): Promise<string> {
	found ??= COMPILED
		? import('epicenter:app-package').then((carried) =>
				writeAppPackage(carried.default),
			)
		: Promise.resolve(
				// Its package folder: two up from its entry, `src/index.ts`.
				dirname(
					dirname(Bun.fileURLToPath(import.meta.resolve('@epicenter/app'))),
				),
			);
	return found;
}

/**
 * Make `folder/node_modules/@epicenter/app` this command's own copy. Call it
 * after every install, which would otherwise leave the link out, and before
 * every UI build. `node_modules/` is ignored.
 */
export async function linkAppPackage(folder: string) {
	const target = await appPackageFolder();
	const link = join(folder, 'node_modules', '@epicenter', 'app');
	try {
		if ((await readlink(link)) === target) return;
	} catch {}
	await rm(link, { recursive: true, force: true });
	await mkdir(dirname(link), { recursive: true });
	await symlink(target, link, 'dir');
}

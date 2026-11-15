/** PROTOTYPE: Build a marked scratch Epicenter, then serve its run experiment. */
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import '../../src/git-environment.test-support.js';
import { linkAppPackage } from '../../src/app-package.js';
import { startHttpServer } from '../../src/http.js';
import { folderPath } from '../../src/root.js';
import { gitIn } from '../../src/runner.test-support.js';

const MARKER = 'PROTOTYPE-wipe-me.txt';
const MARKER_TEXT =
	'PROTOTYPE: wipe me\nHost-owned run experiment; no personal data.\n';

async function realCandidate(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
		return join(
			await realCandidate(dirname(path)),
			path.slice(dirname(path).length + 1),
		);
	}
}

function contains(parent: string, child: string) {
	const rel = relative(parent, child);
	return (
		rel === '' ||
		(rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
	);
}

async function markedOrAbsent(path: string) {
	try {
		if (!(await lstat(path)).isDirectory())
			throw new Error(`Refusing scratch path that is not a directory: ${path}`);
		if (
			!(await readFile(join(path, MARKER), 'utf8')).startsWith(
				'PROTOTYPE: wipe me\n',
			)
		)
			throw new Error('Wrong marker');
	} catch (cause) {
		if (
			(cause as NodeJS.ErrnoException).code === 'ENOENT' &&
			!(await Bun.file(join(path, MARKER)).exists())
		) {
			try {
				await lstat(path);
			} catch (missing) {
				if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw missing;
			}
		}
		throw new Error(
			`Refusing unmarked scratch directory ${path}: ${String(cause)}`,
		);
	}
}

/** PROTOTYPE: Shared with socket-free inspection; writes only marked scratch folders. */
export async function prepareDemo({
	root,
	runtime,
	port,
	fresh = false,
}: {
	root: string;
	runtime: string;
	port: number;
	fresh?: boolean;
}) {
	root = await realCandidate(folderPath(root));
	runtime = await realCandidate(folderPath(runtime));
	const personal = await realCandidate(join(homedir(), 'Epicenter'));
	if (
		contains(personal, root) ||
		contains(root, personal) ||
		contains(personal, runtime) ||
		contains(runtime, personal)
	)
		throw new Error('The prototype cannot use your personal ~/Epicenter');
	if (contains(root, runtime) || contains(runtime, root))
		throw new Error(
			'Scratch root and runtime must be separate folders, outside one another',
		);
	// Validate both paths before deleting either. A marker authorizes only these scratch trees.
	await markedOrAbsent(root);
	await markedOrAbsent(runtime);
	if (fresh) {
		await rm(root, { recursive: true, force: true });
		await rm(runtime, { recursive: true, force: true });
	}
	for (const path of [root, runtime]) {
		await mkdir(path, { recursive: true, mode: 0o700 });
		await writeFile(join(path, MARKER), MARKER_TEXT, { mode: 0o600 });
	}
	await writeFile(
		join(root, 'EPICENTER.md'),
		`---\nport: ${port}\n---\nPROTOTYPE: Host-owned runs.\n`,
	);
	await writeFile(
		join(root, '.gitignore'),
		'# PROTOTYPE: scratch app repositories stay separate.\napps/\n',
	);
	const app = join(root, 'apps', 'runs-demo');
	await mkdir(join(app, 'ui', 'dist'), { recursive: true });
	await writeFile(
		join(app, 'epicenter.ts'),
		await readFile(join(import.meta.dir, 'app', 'epicenter.ts')),
	);
	await writeFile(
		join(app, '.gitignore'),
		'# PROTOTYPE: generated files and data stay outside code history.\ndata/\nnode_modules/\nui/dist/\n',
	);
	await writeFile(
		join(app, 'package.json'),
		JSON.stringify(
			{
				description: 'PROTOTYPE: scratch fixture',
				name: 'runs-demo',
				private: true,
				type: 'module',
			},
			null,
			'\t',
		),
	);
	await linkAppPackage(app);
	for (const path of [root, app]) {
		await gitIn(path, 'init', '-q');
		if (await gitIn(path, 'remote'))
			throw new Error(
				`The prototype refuses repositories with remotes: ${path}`,
			);
	}
	// A reused fixture must never hand the backup clock a remote to push to.
	if (await Bun.file(join(app, 'data', '.git', 'config')).exists())
		if (await gitIn(join(app, 'data'), 'remote'))
			throw new Error('The prototype refuses a data repository with remotes');
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, 'page.ts')],
		outdir: join(app, 'ui', 'dist'),
		target: 'browser',
		format: 'esm',
		naming: 'page.js',
		banner: '/* PROTOTYPE: throwaway host-owned run observer. */',
	});
	if (!built.success) throw new Error(built.logs.map(String).join('\n'));
	await writeFile(
		join(app, 'ui', 'dist', 'index.html'),
		await readFile(join(import.meta.dir, 'index.html')),
	);
	// No ui/index.html or build script: uiSource leaves this prebuilt directory alone.
	return { root, runtime, app };
}

export function demoOptions(args: string[], defaultPort = 4799) {
	let port = defaultPort;
	let fresh = false;
	let root = '/tmp/epicenter-runs-prototype';
	let runtime = '/tmp/epicenter-runs-prototype-runtime';
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--fresh') {
			fresh = true;
			continue;
		}
		const value = args[++index];
		if (value === undefined) throw new Error(`Missing value for ${arg}`);
		switch (arg) {
			case '--port':
				port = Number(value);
				break;
			case '--root':
				root = value;
				break;
			case '--runtime':
				runtime = value;
				break;
			default:
				throw new Error(`Unknown argument ${arg}`);
		}
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('The port must be an integer from 1 to 65535');
	return { root: folderPath(root), runtime: folderPath(runtime), port, fresh };
}

if (import.meta.main) {
	try {
		const options = demoOptions(Bun.argv.slice(2));
		const scratch = await prepareDemo(options);
		process.env.EPICENTER_ROOT = scratch.root;
		process.env.EPICENTER_RUNTIME_DIR = scratch.runtime;
		process.chdir(scratch.root);
		const server = startHttpServer('127.0.0.1', options.port);
		console.log(`PROTOTYPE UI: http://127.0.0.1:${server.port}/runs-demo/`);
		console.log(`PROTOTYPE runtime: ${scratch.runtime}`);
		await new Promise<void>((resolve) => {
			process.once('SIGINT', resolve);
			process.once('SIGTERM', resolve);
		});
		await server.stop();
	} catch (cause) {
		console.error(
			`PROTOTYPE serve failed: ${cause instanceof Error ? cause.stack : String(cause)}`,
		);
		process.exitCode = 1;
	}
}

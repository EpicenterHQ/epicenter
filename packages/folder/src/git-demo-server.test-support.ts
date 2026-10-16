/**
 * Loopback Git smart HTTP for the app demos (`bun dev:todos`, `bun dev:git`)
 * and their tests.
 *
 * Serves one bare repository through the system `git http-backend` CGI with
 * `receive-pack` enabled, and prepares an ordinary native checkout of it.
 * Nothing here is hosted Epicenter infrastructure: there is no account,
 * credential, or external service. It binds 127.0.0.1 only. Like the other
 * `*.test-support.ts` files, it is outside the package's exports; apps
 * import it by path.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { git, gitHttpBackend } from './git-http.test-support.js';

export type GitDemo = {
	/**
	 * Names the bare repository (`<name>.git`), the marker file that lets a
	 * root be reopened (`.epicenter-<name>-demo`), and fresh temporary roots.
	 */
	readonly name: string;
	readonly port: number;
	/** A root this module created earlier, reopened with its history. */
	readonly root?: string;
	/**
	 * Serve the repository at a path named after the root, so each fresh root
	 * has its own remote URL. Otherwise the path is `/git/<name>.git`.
	 */
	readonly urlPerRoot?: boolean;
	/** Files a fresh root's first commit on `main` holds, made in `<root>/seed`. */
	readonly seed?: Readonly<Record<string, string>>;
};

export type GitSession = {
	readonly root: string;
	readonly bare: string;
	readonly nativeCheckout: string;
	/** The URL native Git uses, served by this process. */
	readonly remoteUrl: string;
	/** The path a browser uses same-origin through the UI's proxy. */
	readonly browserRemotePath: string;
	readonly port: number;
};

/** Prepare (or reopen) the demo root and its session description. */
export async function prepareGitSession(demo: GitDemo): Promise<GitSession> {
	const marker = `.epicenter-${demo.name}-demo`;
	const root =
		demo.root ?? (await mkdtemp(join(tmpdir(), `epicenter-${demo.name}-`)));
	if (demo.root && !(await Bun.file(join(root, marker)).exists()))
		throw new Error(
			`${root} has no ${marker}: only a directory this server created can be reopened.`,
		);
	await writeFile(
		join(root, marker),
		`Disposable Epicenter ${demo.name} demo data\n`,
	);
	const repos = join(root, 'repos');
	const bare = join(repos, `${demo.name}.git`);
	const browserRemotePath = demo.urlPerRoot
		? `/git/${encodeURIComponent(basename(root))}.git`
		: `/git/${demo.name}.git`;
	const remoteUrl = `http://127.0.0.1:${demo.port}${browserRemotePath}`;
	if (!(await Bun.file(join(bare, 'HEAD')).exists())) {
		await mkdir(repos, { recursive: true });
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		await git(bare, 'config', 'http.receivepack', 'true');
		await git(bare, 'config', 'receive.denyNonFastForwards', 'true');
	}
	const seed = join(root, 'seed');
	if (demo.seed && !(await Bun.file(join(seed, '.git', 'HEAD')).exists())) {
		await git(root, 'init', '--quiet', '--initial-branch=main', seed);
		for (const [path, text] of Object.entries(demo.seed)) {
			await mkdir(dirname(join(seed, path)), { recursive: true });
			await writeFile(join(seed, path), text);
		}
		await git(seed, 'add', '--', ...Object.keys(demo.seed));
		await git(seed, 'commit', '-qm', 'Start demo');
		await git(seed, 'push', bare, 'main');
	}
	const nativeCheckout = join(root, 'native');
	if (!(await Bun.file(join(nativeCheckout, '.git', 'HEAD')).exists())) {
		await git(root, 'init', '--quiet', '--initial-branch=main', nativeCheckout);
		await git(nativeCheckout, 'remote', 'add', 'origin', remoteUrl);
		await git(nativeCheckout, 'config', 'branch.main.remote', 'origin');
		await git(nativeCheckout, 'config', 'branch.main.merge', 'refs/heads/main');
		await git(nativeCheckout, 'config', 'user.name', 'Native checkout');
		await git(nativeCheckout, 'config', 'user.email', 'native@localhost');
	}
	return {
		root,
		bare,
		nativeCheckout,
		remoteUrl,
		browserRemotePath,
		port: demo.port,
	};
}

/** The request handler: smart HTTP at `browserRemotePath`, and `/session` JSON. */
export async function createGitHandler(session: GitSession) {
	const answer = await gitHttpBackend(dirname(session.bare));
	const repository = `/${basename(session.bare)}`;
	const served = session.browserRemotePath;
	return async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname === '/session') return Response.json(session);
		if (pathname === served || pathname.startsWith(`${served}/`))
			return answer(request, repository + pathname.slice(served.length));
		return new Response('Not found', { status: 404 });
	};
}

/** Serve the demo on `127.0.0.1:<port>` and record it in `<root>/session.json`. */
export async function startGitServer(demo: GitDemo) {
	const session = await prepareGitSession(demo);
	const handle = await createGitHandler(session);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: demo.port,
		idleTimeout: 120,
		async fetch(request) {
			const response = await handle(request);
			const url = new URL(request.url);
			if (url.pathname.startsWith('/git/'))
				console.error(
					`${request.method} ${url.pathname}${url.search} ${response.status}`,
				);
			return response;
		},
	});
	await writeFile(
		join(session.root, 'session.json'),
		`${JSON.stringify(session, null, 2)}\n`,
	);
	return { session, stop: () => server.stop(true) };
}

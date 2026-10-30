import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A disposable, loopback-only native Git smart-HTTP server for integration tests. */
export async function createGitServer() {
	const temporary = await mkdtemp(join(tmpdir(), 'epicenter-data-git-'));
	const directory = join(temporary, 'repo.git');
	const active = new Set<{ kill(): void; exited: Promise<number> }>();
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
	);
	Object.assign(environment, {
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: 'Local fixture',
		GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'Local fixture',
		GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	});

	async function run(
		args: readonly string[],
		input?: Uint8Array | string,
		extraEnvironment?: Record<string, string>,
	) {
		const child = Bun.spawn(
			[
				'git',
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'commit.gpgSign=false',
				'-c',
				'tag.gpgSign=false',
				...args,
			],
			{
				env: { ...environment, ...extraEnvironment },
				stdin:
					input === undefined
						? 'ignore'
						: typeof input === 'string'
							? new TextEncoder().encode(input)
							: input,
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		active.add(child);
		try {
			const [output, error, exitCode] = await Promise.all([
				new Response(child.stdout).arrayBuffer(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (exitCode !== 0)
				throw new Error(`git ${args.join(' ')} exited ${exitCode}: ${error}`);
			return new Uint8Array(output);
		} finally {
			active.delete(child);
		}
	}

	/** Run native Git against this scratch bare repository, without shell expansion. */
	async function git(args: readonly string[], input?: Uint8Array | string) {
		return new TextDecoder().decode(
			await run(['--git-dir', directory, ...args], input),
		);
	}

	try {
		await run(['init', '--bare', '--initial-branch=main', directory]);
		await git(['config', 'http.receivepack', 'true']);
		await git(['config', 'receive.denyNonFastForwards', 'true']);
		await git(['config', 'receive.denyDeletes', 'true']);
		await git(['config', 'core.logAllRefUpdates', 'true']);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (
				!/^\/repo\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(
					url.pathname,
				) ||
				(request.method !== 'GET' && request.method !== 'POST')
			)
				return new Response('Not found', { status: 404 });
			const input = new Uint8Array(await request.arrayBuffer());
			const output = await run(['http-backend'], input, {
				GIT_PROJECT_ROOT: temporary,
				GIT_HTTP_EXPORT_ALL: '1',
				GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method,
				CONTENT_TYPE: request.headers.get('content-type') ?? '',
				CONTENT_LENGTH: String(input.byteLength),
				REMOTE_ADDR: '127.0.0.1',
				SERVER_PROTOCOL: 'HTTP/1.1',
				SERVER_NAME: '127.0.0.1',
			});
			let separator = -1;
			let separatorLength = 0;
			for (let index = 0; index < output.length - 1; index++) {
				if (output[index] === 10 && output[index + 1] === 10) {
					separator = index;
					separatorLength = 2;
					break;
				}
				if (
					output[index] === 13 &&
					output[index + 1] === 10 &&
					output[index + 2] === 13 &&
					output[index + 3] === 10
				) {
					separator = index;
					separatorLength = 4;
					break;
				}
			}
			if (separator < 0) throw new Error('Git CGI response has no headers');
			const headers = new Headers();
			let status = 200;
			for (const line of new TextDecoder()
				.decode(output.subarray(0, separator))
				.split(/\r?\n/)) {
				const colon = line.indexOf(':');
				if (colon < 1) throw new Error(`Invalid Git CGI header: ${line}`);
				const name = line.slice(0, colon);
				const value = line.slice(colon + 1).trim();
				if (name.toLowerCase() === 'status')
					status = Number(value.split(' ')[0]);
				else headers.append(name, value);
			}
			return new Response(output.subarray(separator + separatorLength), {
				status,
				headers,
			});
		},
	});
	let closed = false;

	return {
		url: new URL('repo.git', server.url).href,
		directory,
		git,
		/** Commit explicit text changes on the latest main, using a private index. */
		async commit(
			changes: ReadonlyMap<string, string | null>,
			message = 'Fixture edit',
		) {
			const index = join(temporary, `index-${crypto.randomUUID()}`);
			const env = { GIT_INDEX_FILE: index };
			const indexed = (args: readonly string[], input?: string) =>
				run(['--git-dir', directory, ...args], input, env);
			try {
				const refs = await git([
					'for-each-ref',
					'--format=%(objectname)',
					'refs/heads/main',
				]);
				const parent = refs.trim();
				await indexed(
					parent ? ['read-tree', parent] : ['read-tree', '--empty'],
				);
				for (const [path, text] of changes) {
					if (
						!path ||
						path.includes('\0') ||
						path
							.split('/')
							.some(
								(part) =>
									!part ||
									part === '.' ||
									part === '..' ||
									part.toLowerCase() === '.git',
							)
					)
						throw new Error(`Invalid fixture path: ${path}`);
					const oid =
						text === null
							? '0'.repeat(40)
							: (await git(['hash-object', '-w', '--stdin'], text)).trim();
					await indexed(
						['update-index', '-z', '--index-info'],
						`${text === null ? '0' : '100644'} ${oid}\t${path}\0`,
					);
				}
				const tree = new TextDecoder()
					.decode(await indexed(['write-tree']))
					.trim();
				const head = (
					await git(
						['commit-tree', tree, ...(parent ? ['-p', parent] : [])],
						`${message}\n`,
					)
				).trim();
				await git([
					'update-ref',
					'refs/heads/main',
					head,
					parent || '0'.repeat(40),
				]);
				return head;
			} finally {
				await rm(index, { force: true });
				await rm(`${index}.lock`, { force: true });
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await server.stop(true);
			const children = [...active];
			for (const child of children) child.kill();
			await Promise.all(children.map((child) => child.exited));
			await rm(temporary, { recursive: true, force: true });
		},
	};
}

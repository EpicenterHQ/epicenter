import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function run(args: string[], cwd: string) {
	const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [output, error, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode) throw new Error(`${args.join(' ')}: ${error || output}`);
	return output;
}

export async function prepareFixture(
	base: string,
	desktop: string,
	origin: string,
) {
	await mkdir(base, { recursive: true });
	await mkdir(desktop, { recursive: true });
	const bare = join(base, 'repo.git');
	if (!(await Bun.file(join(bare, 'HEAD')).exists())) {
		await run(['git', 'init', '--bare', '-q', bare], base);
		await run(['git', 'config', 'http.receivepack', 'true'], bare);
	}
	if (!(await Bun.file(join(desktop, '.git/HEAD')).exists())) {
		await run(['git', 'init', '-q', desktop], base);
		await run(['git', 'lfs', 'install', '--local'], desktop);
		await run(['git', 'remote', 'add', 'origin', origin], desktop);
		await run(['git', 'config', 'user.email', 'demo@example.invalid'], desktop);
		await run(['git', 'config', 'user.name', 'Field Notebook Demo'], desktop);
	}
	return { bare, desktop, lfs: join(base, 'lfs') };
}

export async function fixtureResponse(
	request: Request,
	fixture: { bare: string; lfs: string },
	baseUrl: string,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const cors = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
	};
	if (url.pathname === '/repo.git/info/lfs/objects/batch') {
		if (request.method === 'OPTIONS')
			return new Response(null, { headers: cors });
		const body = (await request.json()) as {
			operation: 'upload' | 'download';
			objects: { oid: string; size: number }[];
		};
		return Response.json(
			{
				transfer: 'basic',
				objects: await Promise.all(
					body.objects.map(async ({ oid, size }) => {
						if (!/^[a-f0-9]{64}$/.test(oid))
							return {
								oid,
								size,
								error: { code: 422, message: 'Invalid LFS object ID' },
							};
						const stored = await stat(join(fixture.lfs, oid)).catch(
							() => undefined,
						);
						if (body.operation === 'download' && !stored)
							return {
								oid,
								size,
								error: { code: 404, message: 'LFS object missing' },
							};
						return {
							oid,
							size,
							actions:
								body.operation === 'upload' && stored
									? {}
									: {
											[body.operation]: {
												href: `${baseUrl}/lfs/objects/${oid}`,
											},
										},
						};
					}),
				),
			},
			{ headers: { ...cors, 'Content-Type': 'application/vnd.git-lfs+json' } },
		);
	}
	if (url.pathname.startsWith('/lfs/objects/')) {
		if (request.method === 'OPTIONS')
			return new Response(null, { headers: cors });
		const oid = url.pathname.slice('/lfs/objects/'.length);
		if (!/^[a-f0-9]{64}$/.test(oid))
			return new Response('Invalid object ID', { status: 422, headers: cors });
		const path = join(fixture.lfs, oid);
		if (request.method === 'PUT') {
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (createHash('sha256').update(bytes).digest('hex') !== oid)
				return new Response('Hash mismatch', { status: 422, headers: cors });
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, bytes);
			return new Response(null, { status: 200, headers: cors });
		}
		const bytes = await readFile(path).catch(() => undefined);
		return bytes
			? new Response(bytes, {
					headers: { ...cors, 'Content-Type': 'application/octet-stream' },
				})
			: new Response('Not found', { status: 404, headers: cors });
	}
	if (!url.pathname.startsWith('/repo.git/')) return undefined;
	if (request.method === 'OPTIONS')
		return new Response(null, { headers: cors });
	const input = new Uint8Array(await request.arrayBuffer());
	const child = Bun.spawn(['git', 'http-backend'], {
		cwd: dirname(fixture.bare),
		env: {
			...process.env,
			GIT_PROJECT_ROOT: dirname(fixture.bare),
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.slice(1),
			REQUEST_METHOD: request.method,
			CONTENT_TYPE: request.headers.get('content-type') ?? '',
			CONTENT_LENGTH: String(input.length),
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	child.stdin.write(input);
	child.stdin.end();
	const output = new Uint8Array(await new Response(child.stdout).arrayBuffer());
	await child.exited;
	const boundary = Buffer.from(output).indexOf('\r\n\r\n');
	const alternate =
		boundary < 0 ? Buffer.from(output).indexOf('\n\n') : boundary;
	if (alternate < 0)
		return new Response('Git backend failed', { status: 500, headers: cors });
	const width = boundary < 0 ? 2 : 4;
	const head = new TextDecoder().decode(output.slice(0, alternate));
	const headers = new Headers(cors);
	for (const line of head.split(/\r?\n/)) {
		const separator = line.indexOf(':');
		if (separator > 0)
			headers.set(line.slice(0, separator), line.slice(separator + 1).trim());
	}
	const status = Number(/^Status:\s*(\d+)/im.exec(head)?.[1] ?? 200);
	return new Response(output.slice(alternate + width), { status, headers });
}

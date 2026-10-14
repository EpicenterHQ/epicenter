import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../../src//git/history.ts';
import { createNativeGitBackend } from '../../src//git/native-backend.ts';
import { createGitRunner, nodeGitHost } from '../../src//git/native-host.ts';
import { createNativeFileBoundary } from '../../src//native-store.ts';

const root = await mkdtemp(join(tmpdir(), 'epicenter-native-index-review-'));
let history: ReturnType<typeof createHistory> | undefined;
try {
	const run = createGitRunner(root);
	await run(['init', '--quiet', '--initial-branch=main']);
	await writeFile(join(root, 'a.md'), 'old\n');
	await run(['add', '--', 'a.md']);
	const commit = () =>
		run([
			'-c',
			'user.name=Review',
			'-c',
			'user.email=review@localhost',
			'commit',
			'--quiet',
			'-m',
			'Review fixture',
		]);
	await commit();
	await run(['checkout', '--quiet', '-b', 'incoming']);
	await writeFile(join(root, 'a.md'), 'new\n');
	await run(['add', '--', 'a.md']);
	await commit();
	const incoming = new TextDecoder()
		.decode((await run(['rev-parse', 'HEAD'])).stdout)
		.trim();
	await run(['checkout', '--quiet', 'main']);
	await run(['update-ref', 'refs/remotes/origin/main', incoming]);
	await run(['update-index', '--index-version=4']);
	const boundary = createNativeFileBoundary(root);
	const backend = await createNativeGitBackend({
		root,
		branch: 'main',
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		boundary,
		host: nodeGitHost(root),
	});
	const nativeClean =
		(
			await run(['diff', '--cached', '--quiet', '--no-ext-diff'], {
				allowFailure: true,
			})
		).code === 0;
	history = createHistory({
		backend,
		boundary,
		author: { name: 'Review', email: 'review@localhost' },
	});
	const outcome = await history.pullFastForward();
	console.log(
		JSON.stringify({
			indexVersion: new DataView(
				(await readFile(join(root, '.git/index'))).buffer,
			).getUint32(4),
			nativeClean,
			error: outcome.error?.name,
			message: outcome.error?.message,
		}),
	);
} finally {
	await history?.close();
	await rm(root, { recursive: true, force: true });
}

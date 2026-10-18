/**
 * The local demo Git backend plus the Vite UI. The repository-root
 * `bun dev:todos` command also starts the hosted API for the account flow.
 *
 * The printed session names the native checkout to edit with ordinary Git and
 * the UI to open. `TODOS_DEMO_ROOT` reopens a root an earlier run printed.
 */
import { startGitServer } from '../../../packages/folder/src/git-demo-server.test-support.js';

const appDir = new URL('..', import.meta.url).pathname;
const port = Number(process.env.TODOS_GIT_PORT ?? 5187);
const { session, stop } = await startGitServer({
	name: 'todos',
	port,
	root: process.env.TODOS_DEMO_ROOT,
});
const ui = 'http://127.0.0.1:5186';

console.log(
	[
		'',
		'Epicenter Todos (local demo)',
		`  UI:              ${ui}`,
		`  Remote:          ${session.remoteUrl}  (browser: ${ui}${session.browserRemotePath})`,
		`  Bare repository: ${session.bare}`,
		`  Native checkout: ${session.nativeCheckout}`,
		'',
		'  After connecting to the demo remote and pressing Sync:',
		`    cd ${session.nativeCheckout} && git pull --ff-only`,
		`    bun apps/todos/scripts/native.ts ${session.nativeCheckout} status`,
		'  Then edit, commit, and push natively, and press Sync in the browser.',
		'',
		`Session: ${JSON.stringify(session)}`,
		'',
	].join('\n'),
);

const vite = Bun.spawn([process.execPath, 'x', 'vite', 'dev'], {
	cwd: appDir,
	env: { ...process.env, TODOS_GIT_PORT: String(port) },
	stdout: 'inherit',
	stderr: 'inherit',
	stdin: 'inherit',
});

function shutdown() {
	vite.kill();
	stop();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => {
		shutdown();
		process.exit(0);
	});

const code = await vite.exited;
stop();
process.exit(code);

/**
 * `bun dev:todos`: the loopback Git backend plus the Vite UI.
 *
 * No hosted API, account, or secrets are involved. The printed session names
 * the native checkout to edit with ordinary Git and the UI to open.
 */
import { DEFAULT_GIT_PORT, startGitServer } from '../server/git-server.js';

const appDir = new URL('..', import.meta.url).pathname;
const port = Number(process.env.TODOS_GIT_PORT ?? DEFAULT_GIT_PORT);
const { session, stop } = await startGitServer({ port });
const ui = 'http://127.0.0.1:5186';

console.log(
	[
		'',
		'Epicenter Todos (file-first demo)',
		`  UI:              ${ui}`,
		`  Remote:          ${session.remoteUrl}  (browser: ${ui}${session.browserRemotePath})`,
		`  Bare repository: ${session.bare}`,
		`  Native checkout: ${session.nativeCheckout}`,
		'',
		'  After the browser pushes:',
		`    cd ${session.nativeCheckout} && git pull --ff-only`,
		`    bun apps/todos/scripts/native.ts ${session.nativeCheckout} status`,
		'  Then edit, commit, and push natively, and press Pull in the browser.',
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

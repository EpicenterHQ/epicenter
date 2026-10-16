import { startGitServer } from '../server/git-server.js';

const response = await fetch('http://127.0.0.1:5191/session', {
	signal: AbortSignal.timeout(1000),
}).catch(() => undefined);
const existing = response
	? await (async () => {
			if (!response.ok) throw new Error('Demo session is unavailable');
			const value = await response.json();
			if (
				typeof value.remoteUrl !== 'string' ||
				typeof value.root !== 'string' ||
				typeof value.browserRemotePath !== 'string' ||
				!value.browserRemotePath.startsWith('/git/') ||
				new URL(value.remoteUrl).pathname !== value.browserRemotePath
			)
				throw new Error('Port 5191 belongs to another service');
			return value as import('../server/git-server.js').GitSession;
		})()
	: undefined;
const { session, stop } = existing
	? { session: existing, stop: () => {} }
	: await startGitServer();
console.log(
	`Git lab: http://127.0.0.1:5190\nRemote: ${session.remoteUrl}\nDemo files: ${session.root}`,
);
const child = Bun.spawn([process.execPath, 'x', 'vite', 'dev'], {
	cwd: new URL('..', import.meta.url).pathname,
	stdin: 'inherit',
	stdout: 'inherit',
	stderr: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => {
		child.kill();
		stop();
		process.exit(0);
	});
const code = await child.exited;
stop();
process.exit(code);

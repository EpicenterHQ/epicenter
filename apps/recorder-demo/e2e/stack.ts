/**
 * The demo's end-to-end environment (`runAppStack` in
 * `packages/cli/src/app-stack.test-support.ts`): a disposable Postgres, the
 * local API with temporary Git and LFS stores, a person per browser project
 * with a desktop sandbox, and the demo built against that API and served
 * by `vite preview` on its registered port.
 *
 *   bun apps/recorder-demo/e2e/stack.ts /tmp/state.json
 *   bun apps/recorder-demo/e2e/stack.ts --demo   # `bun run demo`
 */
import { join, resolve } from 'node:path';
import { LOCAL_APPS, localUrl } from '@epicenter/constants/apps';
import { runAppStack } from '../../../packages/cli/src/app-stack.test-support.ts';

const appDir = resolve(import.meta.dir, '..');

await runAppStack({
	name: 'recorder-demo',
	app: localUrl(LOCAL_APPS.RECORDER_DEMO),
	build: (scratch) => ({
		command: [
			process.execPath,
			'x',
			'vite',
			'build',
			'--outDir',
			join(scratch, 'dist'),
			'--emptyOutDir',
			'--logLevel',
			'warn',
		],
		cwd: appDir,
	}),
	serve: (scratch) => ({
		command: [
			process.execPath,
			'x',
			'vite',
			'preview',
			'--outDir',
			join(scratch, 'dist'),
		],
		cwd: appDir,
	}),
	ready: '/contract.json',
	demo: ({ stack, person, signIn, script }) => `
Recorder demo     ${stack.app}
API               ${stack.origin}
Sign in           open ${signIn} (sets the demo person's session), then press Sign in
Desktop sandbox   source '${script}'
                  epicenter clone ${person.namespace}/recorder-demo
                  epicenter check ${stack.app}/contract.json recorder-demo
                  epicenter sync recorder-demo
Stop              Ctrl-C (everything above is deleted)
`,
});

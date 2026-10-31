/**
 * Capture's end-to-end environment (`runAppStack` in
 * `packages/cli/src/app-stack.test-support.ts`): a disposable Postgres, the
 * local API with temporary Git and LFS stores, a person per browser project
 * with a desktop sandbox, and Capture built against that API and served by
 * `vite preview` on its registered origin, `http://localhost:5179`.
 *
 *   bun apps/capture/e2e/stack.ts /tmp/state.json
 *   bun apps/capture/e2e/stack.ts --demo   # `bun run demo`
 */
import { join, resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { runAppStack } from '../../../packages/cli/src/app-stack.test-support.ts';

const appDir = resolve(import.meta.dir, '..');

await runAppStack({
	name: 'capture',
	app: localUrl(APPS.CAPTURE),
	// The static app goes to the scratch directory (`CAPTURE_BUILD_DIR`, read
	// by `svelte.config.js`), never `build/`; `vite preview` serves
	// `.svelte-kit/output`.
	build: (scratch) => ({
		command: [process.execPath, 'x', 'vite', 'build', '--logLevel', 'warn'],
		cwd: appDir,
		env: { CAPTURE_BUILD_DIR: join(scratch, 'build') },
	}),
	serve: () => ({
		command: [process.execPath, 'x', 'vite', 'preview'],
		cwd: appDir,
	}),
	ready: '/contract.json',
	demo: ({ stack, person, signIn, script }) => `
Capture           ${stack.app}
API               ${stack.origin}
Sign in           open ${signIn} (sets the demo person's session), then press Sign in
Desktop sandbox   source '${script}'
                  epicenter clone ${person.namespace}/capture
                  epicenter check ${stack.app}/contract.json capture
                  epicenter sync capture
Stop              Ctrl-C (everything above is deleted)
`,
});

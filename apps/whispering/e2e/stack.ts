/**
 * Whispering's end-to-end environment (`runAppStack` in
 * `packages/cli/src/app-stack.test-support.ts`): a disposable Postgres, the
 * local API with temporary Git and LFS stores, a person per browser project
 * with a desktop sandbox, and Whispering built against that API and served
 * by `vite preview` on its registered origin, `http://localhost:1420`.
 *
 *   bun apps/whispering/e2e/stack.ts /tmp/state.json
 *   bun apps/whispering/e2e/stack.ts --demo
 */
import { join, resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/definition/site';
import { runAppStack } from '../../../packages/cli/src/app-stack.test-support.ts';

const appDir = resolve(import.meta.dir, '..');

await runAppStack({
	name: 'whispering',
	app: localUrl(APPS.WHISPERING),
	// The static app goes to the scratch directory (`WHISPERING_BUILD_DIR`,
	// read by `svelte.config.js`), never `build/`; `vite preview` serves
	// `.svelte-kit/output`.
	build: (scratch) => ({
		command: [process.execPath, 'x', 'vite', 'build', '--logLevel', 'warn'],
		cwd: appDir,
		env: { WHISPERING_BUILD_DIR: join(scratch, 'build') },
	}),
	serve: () => ({
		command: [process.execPath, 'x', 'vite', 'preview'],
		cwd: appDir,
	}),
	ready: '/contract.json',
	demo: ({ stack, signIn, script }) => `
Whispering        ${stack.app}
API               ${stack.origin}
Sign in           open ${signIn} (sets the demo person's session), then Settings, Sign in
                  (optional: it adds hosted transcription and AI; recordings stay in the browser)
Desktop sandbox   source '${script}'
                  epicenter repos
Stop              Ctrl-C (everything above is deleted)
`,
});

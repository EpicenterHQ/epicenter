/**
 * Vocab's end-to-end environment (`runAppStack` in
 * `packages/cli/src/app-stack.test-support.ts`): a disposable Postgres, the
 * local API with temporary Git and LFS stores, a person per browser project
 * with a desktop sandbox, and Vocab built against that API and served by
 * `vite preview` on its registered origin, `http://localhost:8888`.
 *
 *   bun apps/vocab/e2e/stack.ts /tmp/state.json
 *   bun apps/vocab/e2e/stack.ts --demo   # `bun run demo`
 */
import { join, resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { runAppStack } from '../../../packages/cli/src/app-stack.test-support.ts';

const appDir = resolve(import.meta.dir, '..');

await runAppStack({
	name: 'vocab',
	app: localUrl(APPS.VOCAB),
	// The static app goes to the scratch directory (`VOCAB_BUILD_DIR`, read
	// by `svelte.config.js`); `vite preview` serves `.svelte-kit/output`.
	build: (scratch) => ({
		command: [process.execPath, 'x', 'vite', 'build', '--logLevel', 'warn'],
		cwd: appDir,
		env: { VOCAB_BUILD_DIR: join(scratch, 'build') },
	}),
	serve: () => ({
		command: [process.execPath, 'x', 'vite', 'preview'],
		cwd: appDir,
	}),
	ready: '/contract.json',
	demo: ({ stack, person, signIn, script }) => `
Vocab             ${stack.app}
API               ${stack.origin}
Sign in           open ${signIn} (sets the demo person's session), then sign in from the account menu
Desktop sandbox   source '${script}'
                  epicenter clone ${person.namespace}/vocab
                  epicenter check ${stack.app}/contract.json vocab
                  epicenter sync vocab
Stop              Ctrl-C (everything above is deleted)
`,
});

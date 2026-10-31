/**
 * Todos' end-to-end environment (`runAppStack` in
 * `packages/cli/src/app-stack.test-support.ts`): a disposable Postgres, the
 * local API with temporary Git and LFS stores, a person per browser project
 * with a desktop sandbox, and Todos built against that API and served by
 * `vite preview` on its registered origin, `http://localhost:5186`.
 *
 *   bun apps/todos/e2e/stack.ts /tmp/state.json
 *   bun apps/todos/e2e/stack.ts --demo   # `bun run demo`
 */
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { runAppStack } from '../../../packages/cli/src/app-stack.test-support.ts';

const appDir = resolve(import.meta.dir, '..');

await runAppStack({
	name: 'todos',
	app: localUrl(APPS.TODOS),
	// SvelteKit writes the static app to `build/`, which `vite preview` serves.
	build: () => ({
		command: [process.execPath, 'x', 'vite', 'build', '--logLevel', 'warn'],
		cwd: appDir,
	}),
	serve: () => ({
		command: [process.execPath, 'x', 'vite', 'preview'],
		cwd: appDir,
	}),
	ready: '/contract.json',
	demo: ({ stack, person, signIn, script }) => `
Todos             ${stack.app}
API               ${stack.origin}
Sign in           open ${signIn} (sets the demo person's session), then press Sign in
Desktop sandbox   source '${script}'
                  epicenter clone ${person.namespace}/todos
                  epicenter check ${stack.app}/contract.json todos
                  epicenter sync todos
Stop              Ctrl-C (everything above is deleted)
`,
});

/** Start `stack.ts` (Bun) for the whole run, and stop it after. */
import { join } from 'node:path';
import { stackGlobalSetup } from '../../../packages/cli/src/app-e2e.test-support.ts';

export default stackGlobalSetup(
	join(import.meta.dirname, 'stack.ts'),
	'CAPTURE_E2E_STATE',
);

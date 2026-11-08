/**
 * The directory Messages' program keeps its drafts in under the end-to-end
 * suite: made empty when `serve.ts` starts, and read and written by the
 * spec as another program would.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_FOLDER = join(tmpdir(), 'epicenter-messages-e2e');

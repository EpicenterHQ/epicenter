/**
 * The browser leaf: before any folder opens, the person chooses the Local
 * demo or their Epicenter account, and GitHub returns to `/sync`. Everything
 * account-related (`src/lib/account/`) is reached only through here, so the
 * desktop build carries none of it. Importing this module opens nothing.
 */
import GitHubReturn from '../account/GitHubReturn.svelte';
import Start from '../account/Start.svelte';
import type { TodosStart } from './types.js';

export const start: TodosStart = { Start, GitHubReturn };

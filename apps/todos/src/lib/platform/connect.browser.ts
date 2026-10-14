/**
 * The browser leaf: Connect chooses a private GitHub repository through the
 * person's Epicenter account, and GitHub returns to `/sync`. Everything
 * account-related (`src/lib/account/`) is reached only through here, so the
 * desktop build carries none of it. Importing this module opens nothing.
 */
import GitHubPicker from '../account/GitHubPicker.svelte';
import GitHubReturn from '../account/GitHubReturn.svelte';
import type { TodosConnect } from './types.js';

export const connect: TodosConnect = { Picker: GitHubPicker, GitHubReturn };

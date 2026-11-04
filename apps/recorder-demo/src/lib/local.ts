/**
 * The local variant's one folder: this browser's files (`openFolder` with no
 * account), opened once for the page's life and read through `reactive`.
 * Only `/` imports it, so the online variant never opens these files and
 * the local one never makes the OAuth client.
 */
import { openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { recorder } from '../contract.ts';

export const folder = reactive(openFolder(recorder));

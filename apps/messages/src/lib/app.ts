/**
 * Messages' one capability, opened once for the page's life (ADR-0766): the
 * folder of drafts and send attempts, read through `reactive` here, once.
 * Every page, component and module imports it from here.
 *
 * The folder is this browser's files for the origin Messages is served on
 * (OPFS), for good. Messages is local only (ADR-0700): it never signs in,
 * so it passes no account, and nothing uploads, because a draft and its
 * send attempt belong to the Beeper installation on this computer. It
 * passes no site either: a site names the account's repository on the web
 * and the data folder's contract link on the desktop, and Messages has
 * neither. Under the `test` condition it is a folder in memory.
 */
import { openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { messages } from './contract.js';

export const folder = reactive(openFolder(messages));

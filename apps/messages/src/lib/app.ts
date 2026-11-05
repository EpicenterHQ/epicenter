/**
 * Messages' one capability, opened once for the page's life (ADR-0766): the
 * folder of drafts and send attempts, read through `reactive` here, once.
 * Every page, component and module imports it from here.
 *
 * The folder is a directory Messages' program owns on this computer, which
 * the page reaches only through that program, at `/folder` on the origin
 * that served it (ADR-0784; `scripts/serve.ts`, and `vite.config.ts` under
 * `bun dev:messages`). Nothing is kept in this browser, and nothing
 * uploads: Messages never signs in, because a draft and its send attempt
 * belong to the Beeper installation on this computer.
 */
import { openFolder } from '@epicenter/folder';
import { served } from '@epicenter/folder/served';
import { reactive } from '@epicenter/svelte/reactive';
import { messages } from './contract.js';

export const folder = reactive(openFolder(messages, served('/folder')));

/**
 * This browser's files for Vocab (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there with no sign-in in front of
 * them (decision 10). The "On this device" view reads them; signed in, the
 * uploader moves every word, chat and message here into the learner's
 * repository, where the "Synced" view reads it (decisions 12 and 76).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { vocab } from './contract.js';

/** This page's device client. */
export const device = openDevice(vocab);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

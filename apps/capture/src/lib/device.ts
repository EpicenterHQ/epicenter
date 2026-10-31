/**
 * This browser's files for Capture (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there (decision 10). A capture is
 * written here first; signed in, the uploader moves it to the person's
 * `capture` repository (decision 12).
 */

import { capture } from '@epicenter/capture';
import { closeDevice, openDevice } from '@epicenter/folder/browser';

/** This page's device client. */
export const device = openDevice(capture);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

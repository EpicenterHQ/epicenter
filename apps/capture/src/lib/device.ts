/**
 * This browser's files for Capture (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there (decision 10): the "On this
 * device" view's client. Signed in, the uploader moves each capture here to
 * the person's `capture` repository (decisions 12 and 76).
 */

import { capture } from '@epicenter/capture';
import { closeDevice, openDevice } from '@epicenter/folder/browser';

/** This page's device client. */
export const device = openDevice(capture);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

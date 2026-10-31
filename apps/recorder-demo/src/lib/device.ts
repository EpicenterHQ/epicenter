/**
 * This browser's files for the demo (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and there whether or not anyone is signed in
 * (decision 10).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { recorder } from '../contract.ts';

/** This page's device client. */
export const device = openDevice(recorder);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

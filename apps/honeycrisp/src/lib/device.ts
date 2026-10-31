/**
 * This browser's files for Honeycrisp (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there (decision 10): the "On this
 * device" page's client. Signed in, the uploader moves every note and
 * folder here into the repository (decisions 12 and 76).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { honeycrisp } from './contract.js';

/** This page's device client. */
export const device = openDevice(honeycrisp);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

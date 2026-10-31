/**
 * This browser's files for Vocab (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there with no sign-in in front of
 * them (decision 10). What is made here signed out or offline uploads once
 * the learner signs in (decision 12).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { vocab } from './contract.js';

/** This page's device client. */
export const device = openDevice(vocab);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

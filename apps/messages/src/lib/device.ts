/**
 * Messages' device: this page's drafts and attempts, kept in the browser's
 * files for this origin (OPFS), opened once for the page. Messages never
 * signs in, so nothing here uploads: a draft and its send attempt belong to
 * the Beeper installation on this computer.
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { messages } from './contract.js';

/** This page's device client. */
export const device = openDevice(messages);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

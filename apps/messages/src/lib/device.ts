/**
 * Messages' one store: this page's drafts and attempts, kept in the
 * browser's files for this origin (OPFS) for good, opened once for the page.
 * Messages has only the local variant (ADR-0700): it never signs in, and
 * nothing here uploads, because a draft and its send attempt belong to the
 * Beeper installation on this computer.
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { messages } from './contract.js';

/** This page's device client. */
export const device = openDevice(messages);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

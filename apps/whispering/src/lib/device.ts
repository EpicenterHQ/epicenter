/**
 * Where this page keeps Whispering's files: this origin's private files
 * (OPFS, `@epicenter/folder/browser`), at the same paths a desktop folder
 * holds. What is made here signed out or offline uploads once someone signs
 * in (decision 12).
 *
 * Whispering's desktop app, when it comes, opens its folder through
 * `@epicenter/folder/tauri` here instead, and does not upload.
 */
import { openDevice } from '@epicenter/folder/browser';
import { whispering } from './contract.js';

/** This page's device client. */
export const openWhisperingDevice = () => openDevice(whispering);

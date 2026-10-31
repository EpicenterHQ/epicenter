/**
 * The desktop program's device: the folder its shell bound to this window,
 * the one the learner chose on first run (`@epicenter/folder/tauri`). The
 * page names no path. It works with no account; Epicenter, not Vocab,
 * syncs the folder once the learner asks it to (`syncWithEpicenter`).
 */
import { openDevice } from '@epicenter/folder/tauri';
import { vocab } from '../contract.js';

/** This window's device client. */
export const device = openDevice(vocab);

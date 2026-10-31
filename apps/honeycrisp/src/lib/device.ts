/**
 * This browser's files for Honeycrisp (OPFS, `@epicenter/folder/browser`),
 * opened once for the page and always there (decision 10). What is made
 * here signed out or offline uploads once someone signs in (decision 12).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { honeycrisp } from './contract.js';

/** This page's device client. */
export const device = openDevice(honeycrisp);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

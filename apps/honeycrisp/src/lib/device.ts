/**
 * The local variant's store: this browser's files for Honeycrisp (OPFS,
 * `@epicenter/folder/browser`), opened once for the page and only by the
 * local variant's page (the online variant never imports it). Notes and
 * folders stay there for good: they never sync and never upload (ADR-0700).
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { honeycrisp } from './contract.js';

/** This page's device client. */
export const device = openDevice(honeycrisp);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));

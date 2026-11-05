/**
 * Honeycrisp's capabilities, opened once for the page's life (ADR-0766):
 * the account (the web build's sign-in; the desktop window never signs in)
 * and the folder, each read through `reactive` here, once, under its own
 * names. Every page, component and module imports what it uses from here.
 *
 * The folder is the one store of the build: this browser keeps nothing
 * (ADR-0700), so the web opens the signed-in person's `honeycrisp`
 * repository, and the desktop window opens the folder Honeycrisp keeps its
 * notes in. Under the `test` condition it is a folder in memory.
 */
import { APPS } from '@epicenter/definition/site';
import { home, openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { connectAccount } from '#platform/account';
import { honeycrisp } from './contract.js';

const signIn = connectAccount();

export const account = signIn && reactive(signIn);
export const folder = reactive(
	openFolder(honeycrisp, home({ site: APPS.HONEYCRISP.url, account: signIn })),
);

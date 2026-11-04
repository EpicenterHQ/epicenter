/**
 * The page: the recorder over this browser's files (`App.svelte`, over the
 * folder `lib/folder.ts` opens), one store for the page's whole life
 * (ADR-0700). It needs no account and never signs in.
 */
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app') as HTMLElement });

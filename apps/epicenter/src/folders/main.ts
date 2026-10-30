/**
 * The Folders build: the launcher at `/folders/`, and each folder editor
 * window at `/folders/editor/`. The route selects the page and nothing else:
 * an editor's folder is the one the shell bound to its window.
 */

import '@epicenter/ui/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import Editor from './Editor.svelte';

const page = location.pathname.startsWith('/folders/editor/') ? Editor : App;

mount(page, {
	// biome-ignore lint/style/noNonNullAssertion: index.html always ships the mount node.
	target: document.getElementById('app')!,
});

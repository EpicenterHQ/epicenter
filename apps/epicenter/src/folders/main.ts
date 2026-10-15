/** The Folders window: every data folder under the Epicenter folder root. */

import '@epicenter/ui/app.css';
import { mount } from 'svelte';
import App from './App.svelte';

mount(App, {
	// biome-ignore lint/style/noNonNullAssertion: index.html always ships the mount node.
	target: document.getElementById('app')!,
});

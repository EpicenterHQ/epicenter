<!--
	Honeycrisp over this device's repository: `OpenHoneycrisp` opens it with
	the browser host, shows its loading and failure screens, and closes it
	when the page goes away.
-->
<script lang="ts">
	import { openBrowserRepository } from '@epicenter/repository/browser';
	import { honeycrispApp } from '$lib/data.js';
	import OpenHoneycrisp from './components/OpenHoneycrisp.svelte';

	/**
	 * The server to sync with, set at build time, such as
	 * `ws://127.0.0.1:8787/?user=me` from `bun packages/repository/scripts/serve.ts`.
	 * Without one, Honeycrisp keeps its notes on this device.
	 */
	const server: string | undefined = import.meta.env.VITE_HONEYCRISP_SERVER || undefined;
</script>

<OpenHoneycrisp
	open={() => openBrowserRepository({ app: honeycrispApp, name: 'honeycrisp', server: server === undefined ? undefined : { url: server } })}
	syncsTo={server}
/>

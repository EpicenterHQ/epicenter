<!--
	Honeycrisp over this device's repository: `OpenHoneycrisp` opens it with
	the browser host, shows its loading and failure screens, and closes it
	when the page goes away.
-->
<script lang="ts">
	import { openHoneycrisp } from '$lib/open.js';
	import OpenHoneycrisp from './components/OpenHoneycrisp.svelte';

	/**
	 * The server to sync with, set at build time, such as
	 * `http://127.0.0.1:8787/` from `bun packages/repository/scripts/serve.ts`,
	 * and whom to sync as. Without a server, Honeycrisp keeps its notes on this device.
	 */
	const server: string | undefined = import.meta.env.VITE_HONEYCRISP_SERVER || undefined;
	const account: string = import.meta.env.VITE_HONEYCRISP_ACCOUNT || 'me';
</script>

<OpenHoneycrisp open={() => openHoneycrisp({ server, account })} syncsTo={server} />

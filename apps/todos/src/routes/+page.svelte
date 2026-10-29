<script lang="ts">
	import { openTodos } from '$lib/open.js';
	import OpenTodos from './local/OpenTodos.svelte';

	/**
	 * The server to sync with, set at build time, such as
	 * `http://127.0.0.1:8787/` from `bun packages/repository/scripts/serve.ts`,
	 * and whom to sync as. Without a server, Todos keeps its todos on this device.
	 */
	const server: string | undefined = import.meta.env.VITE_TODOS_SERVER || undefined;
	const account: string = import.meta.env.VITE_TODOS_ACCOUNT || 'me';
</script>

<OpenTodos open={() => openTodos({ server, account })} syncsTo={server} />

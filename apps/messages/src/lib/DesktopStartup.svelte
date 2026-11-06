<!-- The desktop shell never substitutes fictional data for a failed program. -->
<script lang="ts">
	import { servedLocally } from './backend.js';
	import MessagesApp from './MessagesApp.svelte';

	const local = await servedLocally();
</script>

{#if local}
	<MessagesApp servedLocally />
{:else}
	<main class="grid min-h-screen place-items-center p-8 text-center">
		<p>Messages could not reach its local program on this computer. Quit Messages and open it again.</p>
	</main>
{/if}

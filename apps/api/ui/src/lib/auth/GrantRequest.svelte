<!--
	What an app is asking for, on the consent page, which also approves device
	codes (ADR-0549). The page describes the scopes the app requested.
-->
<script lang="ts">
	import { describeScopes } from './oauth-request';

	let { scopes }: { scopes: readonly string[] } = $props();

	const lines = $derived(describeScopes(scopes));
</script>

{#if lines.length}
	<ul class="list-disc space-y-1 pl-5 text-sm">
		{#each lines as line (line)}<li>{line}</li>{/each}
	</ul>
{/if}

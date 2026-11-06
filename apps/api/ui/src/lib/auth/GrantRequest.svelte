<!--
	What an app is asking for, on the consent page, which also approves device
	codes (ADR-0549). Which folders a grant reaches is its scopes: an app
	reaches the folders attached to it, and only `folders:all` reaches every
	folder (ADR-0811).
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

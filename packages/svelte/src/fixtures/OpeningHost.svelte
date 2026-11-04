<!-- `<Opening>` over `folder`, its pages a line of text, or a page that throws while it renders. -->
<script lang="ts">
	import Opening from '../opening.svelte';
	import Throws from './Throws.svelte';

	let { folder, crash = false }: { folder: Parameters<typeof Opening>[1]['folder']; crash?: boolean } =
		$props();
</script>

<Opening app="Todos" {folder}>
	{#if crash}<Throws />{:else}<p data-testid="pages">pages</p>{/if}
</Opening>

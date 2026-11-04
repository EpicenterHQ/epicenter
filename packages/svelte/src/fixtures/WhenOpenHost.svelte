<!-- `<WhenOpen>` over `folder`, its pages a line of text, or a page that throws while it renders. -->
<script lang="ts">
	import WhenOpen from '../when-open.svelte';
	import Throws from './Throws.svelte';

	let { folder, crash = false }: { folder: Parameters<typeof WhenOpen>[1]['folder']; crash?: boolean } =
		$props();
</script>

<WhenOpen app="Todos" {folder}>
	{#if crash}<Throws />{:else}<p data-testid="pages">pages</p>{/if}
</WhenOpen>

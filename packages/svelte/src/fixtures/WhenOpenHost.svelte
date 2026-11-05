<!-- `<WhenOpen>` over `folder` and, when given, `settings`, its pages a line of text, or a page that throws while it renders. -->
<script lang="ts">
	import WhenOpen from '../when-open.svelte';
	import Throws from './Throws.svelte';

	type Props = Parameters<typeof WhenOpen>[1];
	let {
		folder,
		settings,
		crash = false,
	}: { folder: Props['folder']; settings?: Props['settings']; crash?: boolean } = $props();
</script>

<WhenOpen app="Todos" {folder} {settings}>
	{#if crash}<Throws />{:else}<p data-testid="pages">pages</p>{/if}
</WhenOpen>

<script lang="ts" generics="TTables extends Tables">
	import type { Opened, Tables } from '@epicenter/folder/next';
	import OpenFolder from '../open-folder.svelte';

	let {
		open,
		holdWindowClose,
		class: className,
	}: {
		open: () => Opened<TTables>;
		holdWindowClose?: boolean;
		class?: string;
	} = $props();
</script>

<OpenFolder {open} {holdWindowClose} class={className}>
	{#snippet children(_folder)}<span>Ready</span>{/snippet}
</OpenFolder>

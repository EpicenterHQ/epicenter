<script lang="ts" generics="TTables extends Tables">
	import type { Opened, Tables } from '@epicenter/folder/next';
	import DraftHost from './DraftHost.svelte';
	import OpenFolder from '../open-folder.svelte';

	let {
		open,
		holdWindowClose,
		class: className,
		edit = false,
	}: {
		open: () => Opened<TTables>;
		holdWindowClose?: boolean;
		class?: string;
		edit?: boolean;
	} = $props();
</script>

<OpenFolder {open} {holdWindowClose} class={className}>
	{#snippet children(folder)}
		<span>Ready</span>
		{#if edit}
			<DraftHost
				source={() => { const data = folder.file('note.txt')?.data; return typeof data === 'string' ? data : ''; }}
				save={(value) => folder.write('note.txt', value)}
				expose={() => {}}
			/>
		{/if}
	{/snippet}
</OpenFolder>

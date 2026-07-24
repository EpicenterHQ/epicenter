<script lang="ts">
	import { getSkillsApp } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkillsApp();

	async function openReference() {
		const { data, error } = await skills.references
			.record(id)
			.document.open();
		if (error !== null) throw error;
		return data;
	}

	const lease = $derived(openReference());
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.asyncDispose](),
				() => undefined,
			);
	});
</script>

<div class="h-48 border-t">
	{#await lease then opened}
		<CodeMirrorEditor document={opened} />
	{/await}
</div>

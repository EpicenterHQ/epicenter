<script lang="ts">
	import { getSkillsApp } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();
	const skills = getSkillsApp();

	async function openInstructions() {
		const { data, error } = await skills.skills
			.record(skillId)
			.document.open();
		if (error !== null) throw error;
		return data;
	}

	const lease = $derived(openInstructions());
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.asyncDispose](),
				() => undefined,
			);
	});
</script>

{#await lease then opened}
	<CodeMirrorEditor document={opened} />
{/await}

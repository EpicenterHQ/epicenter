<script lang="ts">
	import { recordings } from '#lib/recordings.ts';

	let { id }: { id: string } = $props();

	let src = $state<string>();
	let failed = $state<string>();

	// The audio is read when the player mounts and its URL freed when it goes.
	$effect(() => {
		let url: string | undefined;
		let gone = false;
		void recordings.audio(id).then(({ data, error }) => {
			if (gone) return;
			if (error) failed = error.message;
			else src = url = URL.createObjectURL(data);
		});
		return () => {
			gone = true;
			if (url) URL.revokeObjectURL(url);
		};
	});
</script>

{#if failed}
	<p class="text-sm text-muted-foreground">{failed}</p>
{:else if src}
	<audio controls {src} class="h-9 w-full"></audio>
{/if}

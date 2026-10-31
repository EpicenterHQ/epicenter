<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { getWhispering } from '$lib/whispering.svelte.js';

	/**
	 * Recordings this browser could not keep (a private window keeps no
	 * files; a full disk refuses). Their audio stays in this page, to save
	 * again or download, until one of those works or the page closes.
	 */
	const whispering = getWhispering();

	async function saveAgain(id: string) {
		const problem = await whispering.saveRecordingAgain(id);
		if (problem) toast.error('The recording is still not kept', { description: problem });
	}
</script>

{#each whispering.unsavedRecordings as held (held.id)}
	<div class="flex w-full flex-col gap-1.5 rounded-md border border-destructive/50 p-3 text-sm" role="alert" data-testid="unsaved-recording">
		<p><span class="font-medium">{held.title}</span> is not kept in this browser: {held.reason}</p>
		<div class="flex flex-wrap items-center gap-1">
			<Button size="xs" onclick={() => void saveAgain(held.id)}>Save again</Button>
			<Button size="xs" variant="outline" href={held.download} download="{held.id}.{held.ext}">Download it</Button>
			<Button size="xs" variant="ghost" onclick={() => whispering.discardRecording(held.id)}>Discard</Button>
		</div>
	</div>
{/each}

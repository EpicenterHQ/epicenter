<!--
	The models that transcribe in this app's process, where there are any
	(`speech`, null in a browser): download one here and use it for
	Transcription. `speech` is the same handle Whispering's models merge, so
	a download lists at once.
-->
<script lang="ts">
	import type { LocalSpeech } from '@epicenter/transcription';
	import LocalModelAdministration from '@epicenter/transcription/local-model-administration';
	import { getWhispering } from '../whispering.svelte.js';

	let { speech }: { speech: LocalSpeech } = $props();
	const whispering = getWhispering();

	/** The local model in use is Whispering's transcription choice, when it names one here. */
	const choice = {
		chosen() {
			const chosen = whispering.choice('transcription');
			return chosen?.endpoint === speech.id ? chosen.model : null;
		},
		choose: (model: string) => whispering.choose('transcription', { endpoint: speech.id, model }),
	};
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-models">
	<p class="text-sm font-medium">On this computer</p>
	<p class="text-muted-foreground">
		Transcribe without sending audio anywhere: download a model here and use it for Transcription, or choose it below, where it is listed under On this computer.
	</p>
	<LocalModelAdministration {speech} {choice} />
</section>

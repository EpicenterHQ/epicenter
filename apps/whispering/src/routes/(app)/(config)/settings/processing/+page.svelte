<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import {
		CompletionRuntimeConfig,
		TranscriptionRuntimeConfig,
	} from '$lib/components/settings';
</script>

<svelte:head> <title>Privacy & Processing - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Privacy &amp; Processing</Field.Legend>
	<Field.Description>
		Choose where each stage of the pipeline runs. Audio is transcribed first,
		then optional cleanup can improve the text. Each stage can stay on this
		device or go to a provider you pick.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Audio (transcription)</Field.Legend>
			<Field.Description>
				Where your recording is turned into text.
			</Field.Description>
			<TranscriptionRuntimeConfig />
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Text cleanup</Field.Legend>
			<Field.Description>
				Where transcript text goes for AI cleanup.
			</Field.Description>
			<CompletionRuntimeConfig />
		</Field.Set>
	</Field.Group>
</Field.Set>

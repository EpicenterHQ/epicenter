<!--
	Home before the first model is downloaded: what Whispering needs, and
	one button that gets it. It takes the recorder's place, since a take
	made now would get no text. No setting says "first run": Home shows this
	whenever the chosen model is not on the computer, so removing the model
	brings it back.

	It only shows what it is given, so the preview page can show each state.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import studioMicrophone from '#lib/assets/studio-microphone.png';

	let {
		name,
		sizeBytes,
		share,
		error,
		ondownload,
	}: {
		/** The model to download, as a person reads it: "Parakeet TDT 0.6B v3". */
		name: string;
		sizeBytes: number;
		/** How far the download is, from 0 to 1; undefined when none is under way. */
		share?: number;
		/** Why the last download stopped, when it did. */
		error?: string;
		ondownload: () => void;
	} = $props();

	const megabytes = $derived(`${Math.round(sizeBytes / 1_000_000)} MB`);
</script>

<section class="flex flex-col items-center gap-6 py-8 text-center" aria-label="Set up transcription">
	<img src={studioMicrophone} alt="" class="size-36 drop-shadow-lg" />

	<div class="flex max-w-md flex-col items-center gap-2">
		<h1 class="text-2xl font-medium">Download a model to start dictating</h1>
		<p class="text-sm text-muted-foreground">
			Whispering turns speech into text on this computer. The model is a {megabytes} download,
			once. After that it works offline, and nothing you say leaves your computer.
		</p>
	</div>

	{#if share !== undefined}
		<div class="flex w-full max-w-xs flex-col items-center gap-2" role="status">
			<Progress value={share * 100} aria-label="Downloading {name}" />
			<p class="text-sm text-muted-foreground tabular-nums">
				Downloading {name}: {Math.round(share * 100)}%
			</p>
			<p class="text-xs text-muted-foreground">You can leave this screen. The download carries on.</p>
		</div>
	{:else}
		<div class="flex flex-col items-center gap-2">
			<Button size="lg" onclick={ondownload}>
				{error ? 'Try again' : `Download ${name}`}
			</Button>
			{#if error}
				<p class="max-w-md text-sm text-destructive" role="alert">{error}</p>
			{/if}
		</div>
	{/if}

	<Button variant="link" size="sm" class="h-auto p-0 text-muted-foreground" href="/settings/transcription">
		Use another model, or a server
	</Button>
</section>

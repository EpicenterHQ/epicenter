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
	import DownloadIcon from '@lucide/svelte/icons/download';

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

	const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
</script>

<section
	class="flex flex-col gap-5 rounded-xl bg-card p-6 text-card-foreground shadow-xs ring-1 ring-foreground/10"
	aria-label="Set up transcription"
>
	<div class="flex items-start gap-4">
		<div class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
			<DownloadIcon class="size-6" />
		</div>
		<div class="flex min-w-0 flex-col gap-1">
			<h2 class="text-lg font-semibold">One download, then you can dictate</h2>
			<p class="text-sm text-muted-foreground">
				Whispering turns speech into text on this computer. It needs a speech model, {name}, once.
				After that it works offline, and nothing you say leaves your computer.
			</p>
		</div>
	</div>

	{#if share !== undefined}
		<div class="flex flex-col gap-2" role="status">
			<Progress value={share * 100} aria-label="Downloading {name}" />
			<p class="flex justify-between text-sm text-muted-foreground tabular-nums">
				<span>{megabytes(share * sizeBytes)} of {megabytes(sizeBytes)}</span>
				<span>{Math.round(share * 100)}%</span>
			</p>
			<p class="text-xs text-muted-foreground">You can leave this screen. The download carries on.</p>
		</div>
	{:else}
		{#if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<Button onclick={ondownload}>
				<DownloadIcon />
				{error ? 'Try again' : 'Download'} · {megabytes(sizeBytes)}
			</Button>
			<Button variant="link" size="sm" class="h-auto p-0 text-muted-foreground" href="/settings/transcription">
				Use another model, or a server
			</Button>
		</div>
	{/if}
</section>

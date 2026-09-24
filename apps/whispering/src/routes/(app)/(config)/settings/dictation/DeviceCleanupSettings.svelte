<script lang="ts">
	import { resolve } from '$app/paths';
	import { SettingSwitch } from '$lib/components/settings';
	import { DEVICE_DEFAULTS } from '$lib/operations/settings.js';
	import { polishDestination, polishStatus } from '$lib/state/polish.js';
	import { getWhisperingApp } from '$lib/whispering/context';
	import { local } from '$lib/whispering/local.js';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';

	const app = getWhisperingApp();
	const polish = $derived(polishStatus(app));
	const destination = $derived(polishDestination(app));
</script>

<Field.Set>
	<Field.Legend variant="label">Cleanup</Field.Legend>
	<Field.Description>
		Fix punctuation and spelling while keeping your wording.
	</Field.Description>
	<Field.Group>
		<SettingSwitch
			checked={local.kv.get('polishEnabled') ?? DEVICE_DEFAULTS.polishEnabled}
			onCheckedChange={(checked) => local.kv.update({ polishEnabled: checked })}
			label="Clean up transcripts with AI"
			description="Turn off to use the original transcription without an AI pass."
		/>
		{#if local.kv.get('polishEnabled') ?? DEVICE_DEFAULTS.polishEnabled}
			<p class="text-muted-foreground text-sm">{destination}</p>
		{/if}
		{#if polish === 'needs-connection'}
			<div
				class="border-amber-500/30 bg-amber-500/10 text-foreground flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm"
			>
				<KeyRoundIcon class="mt-0.5 size-4 shrink-0 text-amber-500" />
				<p>
					Cleanup is on, but no text connection is selected. Transcriptions use
					their original text. <Link href={resolve('/settings/processing')}
						>Choose a connection</Link
					> to enable cleanup.
				</p>
			</div>
		{/if}
	</Field.Group>
</Field.Set>

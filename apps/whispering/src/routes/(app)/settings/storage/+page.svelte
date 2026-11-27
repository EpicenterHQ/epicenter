<!--
	Settings · Storage. Where the recordings are, how many, how much room
	they take, and how long they are kept. Keeping fewer days deletes the
	older recordings at once, so it asks first and says how many. The folder
	opens in the file manager on the desktop; a browser's files are its own
	and no file manager shows them.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Select from '@epicenter/ui/select';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import { toast } from 'svelte-sonner';
	import { runMutation } from 'wellcrafted/query';
	import { olderThan } from '#lib/feed.ts';
	import { files } from '#lib/platform/index.ts';
	import { queryClient, recordingsMutations, recordingsQueries, settingsMutations, settingsQueries } from '#lib/queries.ts';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';

	/** The choices for how long to keep recordings; an empty value keeps every one. */
	const KEEP = [
		{ value: '', label: 'Forever' },
		{ value: '7', label: '7 days' },
		{ value: '30', label: '30 days' },
		{ value: '90', label: '90 days' },
		{ value: '365', label: 'A year' },
	];

	const list = createQuery(() => recordingsQueries.list());
	const size = createQuery(() => recordingsQueries.size());
	const settings = createQuery(() => settingsQueries.read());
	const count = $derived(list.data?.length ?? 0);
	const keepDays = $derived(settings.data?.['recordings.keepDays'] ?? null);
	const keepValue = $derived(keepDays === null ? '' : String(keepDays));
	const keepLabel = $derived(
		KEEP.find((choice) => choice.value === keepValue)?.label ?? `${keepDays} days`,
	);

	/** `bytes` as a person reads a file's size: `12.4 MB`. */
	function readable(bytes: number) {
		const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
		let amount = bytes;
		let unit = 0;
		while (amount >= 1000 && unit < units.length - 1) {
			amount /= 1000;
			unit++;
		}
		return `${unit === 0 ? amount : amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`;
	}

	async function keep(days: number | null) {
		const saved = await runMutation(queryClient, settingsMutations.update, { 'recordings.keepDays': days });
		if (saved.error) return toastOnError(saved, 'Could not save the setting');
		if (days === null) return;
		const deleted = await runMutation(queryClient, recordingsMutations.deleteOlderThan, { keepDays: days });
		if (deleted.error) return toastOnError(deleted, 'Could not delete old recordings');
		if (deleted.data > 0)
			toast.success(`Deleted ${deleted.data.toLocaleString()} old ${deleted.data === 1 ? 'recording' : 'recordings'}`);
	}

	function choose(value: string) {
		if (value === keepValue) return;
		const days = value === '' ? null : Number(value);
		const old = days === null ? [] : olderThan((list.data ?? []).map((recording) => recording.id), days, new Date());
		if (old.length === 0) return void keep(days);
		confirmationDialog.open({
			title: `Delete ${old.length.toLocaleString()} ${old.length === 1 ? 'recording' : 'recordings'}?`,
			description: `Keeping ${days} days deletes every recording older than that now, audio and text, and each one as it reaches that age. This cannot be undone.`,
			confirm: { text: 'Delete them', variant: 'destructive' },
			onConfirm: () => keep(days),
		});
	}

	async function reveal() {
		const shown = await files.reveal?.();
		if (shown?.error) toast.error('Could not open the folder', { description: shown.error.message });
	}
</script>

<svelte:head><title>Storage · Whispering</title></svelte:head>

<SettingsSection title="Storage" description="Each recording is a Markdown note and an audio file, kept in {files.keptIn}.">
	<SettingsRow label="Recordings">
		<span class="text-sm tabular-nums">{count.toLocaleString()}</span>
	</SettingsRow>
	<SettingsRow label="Size on disk">
		<span class="text-sm tabular-nums">{size.data === undefined ? '' : readable(size.data)}</span>
	</SettingsRow>
	<SettingsRow
		label="Keep recordings"
		description="Older ones are deleted, audio and text, after a take and when Whispering opens."
		for="keep"
	>
		<Select.Root type="single" value={keepValue} onValueChange={choose}>
			<Select.Trigger id="keep" class="w-32">{keepLabel}</Select.Trigger>
			<Select.Content>
				{#each KEEP as choice (choice.value)}
					<Select.Item value={choice.value}>{choice.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
	{#if files.reveal}
		<SettingsRow label="The folder" description="Plain files you can open, copy and back up.">
			<Button variant="outline" size="sm" onclick={reveal}><FolderOpenIcon /> Open the folder</Button>
		</SettingsRow>
	{:else}
		<SettingsRow
			label="The folder"
			description="A browser keeps these files where no file manager shows them. The desktop app keeps them in a folder you can open."
			disabled
		/>
	{/if}
</SettingsSection>

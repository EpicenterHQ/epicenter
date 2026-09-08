<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Field from '@epicenter/ui/field';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
	import { report } from '$lib/report';
	import type { UnscopedAudio } from '$lib/whispering/recording-audio';

	/**
	 * What an earlier version of Whispering left in the origin-wide store and
	 * this account has not yet claimed (ADR-0349). It may be another account's,
	 * so nothing deletes it but a person who has been told that (ADR-0351).
	 * Renders nothing when there is nothing.
	 */
	let { unscoped }: { unscoped: UnscopedAudio } = $props();

	const summary = createQuery(() =>
		resultQueryOptions({
			queryKey: ['audio', 'unclaimed'],
			queryFn: () => unscoped.summary(),
		}),
	);

	const remove = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['audio', 'unclaimed', 'delete'],
			mutationFn: () => unscoped.delete(),
			onSuccess: () => {
				report.success({ title: 'Unclaimed audio deleted' });
				void summary.refetch();
			},
			onError: (error) => {
				report.error({ title: 'Could not delete unclaimed audio', cause: error });
			},
		}),
	);

	const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
</script>

{#if summary.data && summary.data.count > 0}
	{@const { count, bytes } = summary.data}
	<Field.Field>
		<Field.Label>Unclaimed audio</Field.Label>
		<Field.Description>
			{count}
			{count === 1 ? 'audio file' : 'audio files'} ({megabytes(bytes)} MB) from
			an earlier version of Whispering are kept on this device and are not
			claimed by this account. Some may belong to another account that used
			this browser. Deleting them does not touch anything online.
		</Field.Description>
		<Button
			variant="outline"
			class="w-fit"
			disabled={remove.isPending}
			onclick={() =>
				confirmationDialog.open({
					title: 'Delete unclaimed audio?',
					description: `This deletes ${count} ${count === 1 ? 'audio file' : 'audio files'} (${megabytes(bytes)} MB) that have not been moved into this account. Some may still be needed by this account or another account on this browser. Deleting them cannot be undone. Nothing online is affected.`,
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => remove.mutate(),
				})}
		>
			{remove.isPending ? 'Deleting...' : 'Delete unclaimed audio'}
		</Button>
	</Field.Field>
{/if}

<script lang="ts">
	import type { FirstAttachmentChoice } from '@epicenter/data/record';
	import { Button } from '@epicenter/ui/button';
	import { auth } from '#platform/auth';
	import { getHoneycrispApp } from '$lib/context.js';

	const honeycrisp = getHoneycrispApp();
	let attachment = $state(honeycrisp.attachment);
	let authState = $state(auth.state);
	let choosing = $state<FirstAttachmentChoice>();
	let error = $state<string>();

	$effect(() => {
		attachment = honeycrisp.attachment;
		return honeycrisp.subscribeAttachment((next) => (attachment = next));
	});

	$effect(() => {
		authState = auth.state;
		return auth.onStateChange((next) => (authState = next));
	});

	async function choose(choice: FirstAttachmentChoice): Promise<void> {
		choosing = choice;
		error = undefined;
		try {
			await honeycrisp.chooseFirstAttachment(choice);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not attach local notes';
		} finally {
			choosing = undefined;
		}
	}
</script>

{#if attachment.kind === 'unattached' && attachment.requiresChoice && authState.status === 'signed-in'}
	<div class="mx-2 mb-2 space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
		<p class="font-medium">Choose what to do with notes saved on this device.</p>
		<p class="text-muted-foreground">
			Bring keeps them and adds them to your account. Discard permanently removes
			them before syncing.
		</p>
		<div class="flex gap-2">
			<Button
				size="sm"
				disabled={choosing !== undefined}
				onclick={() => choose('bring')}
			>
				{choosing === 'bring' ? 'Bringing…' : 'Bring local notes'}
			</Button>
			<Button
				variant="destructive"
				size="sm"
				disabled={choosing !== undefined}
				onclick={() => choose('discard')}
			>
				{choosing === 'discard' ? 'Discarding…' : 'Discard local notes'}
			</Button>
		</div>
		{#if error}
			<p class="text-destructive" aria-live="polite">{error}</p>
		{/if}
	</div>
{/if}

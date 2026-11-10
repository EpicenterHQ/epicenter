<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { toast } from '@epicenter/ui/sonner';
	import { mailbox } from '$lib/mail.svelte.js';

	let open = $state(false);
	let name = $state('');
	let title = $state('');
	let saving = $state(false);

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void save();
	}

	async function save() {
		saving = true;
		try {
			const path = await mailbox.save(name.trim(), title.trim());
			open = false;
			name = '';
			title = '';
			window.location.hash = `#/${path}`;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			saving = false;
		}
	}
</script>

<Modal.Root bind:open>
	<Button
		variant="outline"
		size="sm"
		disabled={!mailbox.result()}
		onclick={() => {
			open = true;
		}}
	>
		Save search
	</Button>
	<Modal.Content>
		<Modal.Header>
			<Modal.Title>Save search</Modal.Title>
			<Modal.Description>Keep this search to open again.</Modal.Description>
		</Modal.Header>
		<form class="space-y-4" onsubmit={submit}>
			<div class="space-y-2">
				<Label for="search-name">Name</Label>
				<Input id="search-name" required bind:value={name} placeholder="receipts" />
			</div>
			<div class="space-y-2">
				<Label for="search-title">Title (optional)</Label>
				<Input id="search-title" bind:value={title} placeholder="Receipts" />
			</div>
			<p class="break-words text-sm text-muted-foreground">{mailbox.result()?.query || 'All mail'}</p>
			<Modal.Footer>
				<Button type="submit" disabled={saving || !name.trim()}>
					{saving ? 'Saving…' : 'Save search'}
				</Button>
			</Modal.Footer>
		</form>
	</Modal.Content>
</Modal.Root>

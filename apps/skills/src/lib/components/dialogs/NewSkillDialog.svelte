<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { getSkills } from '$lib/context.js';
	import { runSkillsMutation } from '$lib/mutation.js';
	import { validateSkill } from '$lib/utils/validation';

	const { state: skillsState } = getSkills();

	let isOpen = $state(false);
	let name = $state('');
	let error = $state('');

	function handleCreate() {
		const trimmed = name.trim();
		if (!trimmed) return;

		const errors = validateSkill({
			name: trimmed,
			description: 'TODO: describe when and why to use this skill.',
		});
		const nameErrors = errors.filter((e) => e.includes('name'));
		if (nameErrors.length > 0) {
			error = nameErrors[0] ?? 'Invalid name';
			return;
		}

		runSkillsMutation(() => {
			skillsState.createSkill(trimmed);
			toast.success(`Created skill: ${trimmed}`);
			isOpen = false;
			name = '';
			error = '';
		}, 'Could not create skill');
	}
</script>

<Dialog.Root bind:open={isOpen}>
	<Button
		tooltip="New skill"
		variant="ghost"
		size="icon-xs"
		onclick={() => (isOpen = true)}
	>
		<PlusIcon class="size-3.5" />
	</Button>
	<Dialog.Content class="max-w-sm sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New Skill</Dialog.Title>
			<Dialog.Description
				>Creates a new skill with default metadata.</Dialog.Description
			>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label>Skill Name</Label>
			<Input
				bind:value={name}
				placeholder="my-skill"
				class="font-mono"
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void handleCreate();
					}
				}}
			/>
			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Lowercase, hyphens only (1-64 chars)
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (isOpen = false)}>Cancel</Button>
			<Button onclick={() => void handleCreate()} disabled={!name.trim()}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

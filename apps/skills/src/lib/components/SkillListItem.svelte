<script lang="ts">
	import type { Skill } from '@epicenter/skills';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as Item from '@epicenter/ui/item';
	import { cn } from '@epicenter/ui/utils';
	import { getSkills } from '$lib/context.js';
	import { runSkillsMutation } from '$lib/mutation.js';

	const { state: skillsState } = getSkills();

	let {
		skill,
		onRequestRename,
	}: {
		skill: Skill;
		onRequestRename: () => void;
	} = $props();

	const isSelected = $derived(skillsState.selectedSkillId === skill.id);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		{#snippet child({ props })}
			<Item.Button
				{...props}
				size="sm"
				class={cn(
					'w-full text-left',
					isSelected
						? 'bg-accent text-accent-foreground'
						: 'hover:bg-accent/50',
				)}
				role="option"
				aria-selected={isSelected}
				onclick={() => skillsState.selectSkill(skill.id)}
			>
				<Item.Content>
					<Item.Title class="font-mono">{skill.name}</Item.Title>
					<Item.Description class="block max-w-full truncate text-xs">
						{skill.description}
					</Item.Description>
				</Item.Content>
			</Item.Button>
		{/snippet}
	</ContextMenu.Trigger>
	<ContextMenu.Content>
		<ContextMenu.Item onclick={onRequestRename}>
			Rename
			<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
		</ContextMenu.Item>
		<ContextMenu.Item
			variant="destructive"
			onclick={() => {
				skillsState.selectSkill(skill.id);
				confirmationDialog.open({
					title: `Delete ${skill.name}?`,
					description:
						'This will delete the skill and its known reference records. This action cannot be undone.',
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () =>
						runSkillsMutation(
							() => skillsState.deleteSkill(skill.id),
							'Could not delete skill',
						),
				});
			}}
		>
			Delete
			<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { getPersonal } from '../whispering/personal.js';
	import { getWhisperingApp } from '../whispering/context.js';
	import { saveToPersonal } from '../operations/save-to-personal.js';
	import { report } from '../report/index.js';
	const personal = getPersonal();
	const app = getWhisperingApp();
	let { recordingId }: { recordingId: string } = $props();
	let saving = $state(false);
	async function save() {
		if (saving || app.signal.aborted) return;
		saving = true;
		const result = await saveToPersonal(app, personal, recordingId);
		saving = false;
		if (app.signal.aborted) return;
		if (result.error)
			report.error({
				title: 'Could not finish saving to Personal',
				cause: result.error,
			});
		else
			report.success({
				title: 'Saved to Personal on this device',
				description:
					'Audio was copied. The independent recording will sync when connected.',
			});
	}
</script>

<Button variant="ghost" size="sm" onclick={save} disabled={saving}
	>{saving ? 'Saving…' : 'Save to Personal'}</Button
>

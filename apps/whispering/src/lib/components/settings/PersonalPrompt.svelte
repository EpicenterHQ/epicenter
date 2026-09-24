<script lang="ts">
	import { Textarea } from '@epicenter/ui/textarea';
	import { getPersonal } from '../../whispering/personal.js';
	const personal = getPersonal();
</script>

<Textarea
	id="transcription-prompt"
	value={personal.kv.get('transcriptionPrompt') ?? ''}
	onblur={(event) =>
		personal.kv.update({ transcriptionPrompt: event.currentTarget.value })}
/>

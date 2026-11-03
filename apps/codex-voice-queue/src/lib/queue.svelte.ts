import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { type Api, ApiError } from './api.js';
import type {
	ArchiveResponse,
	GatewayState,
	Health,
	SendResponse,
	ThreadSummary,
	ThreadsResponse,
	TranscriptionResponse,
	TurnsResponse,
} from './api-types.js';
import { VoiceRecorder } from './recorder.svelte.js';
import { matchesThread, neighborId, projectOptions } from './thread-filter.js';

type Flow =
	| 'idle'
	| 'recording'
	| 'transcribing'
	| 'sending'
	| 'transcribeFailed'
	| 'sendFailed'
	| 'sendUnknown'
	| 'checking';
export type TranscriptState = {
	loading: boolean;
	error: string | null;
	data: TurnsResponse | null;
};
function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
export class VoiceQueue {
	threads = new SvelteMap<string, ThreadSummary>();
	order = $state.raw<string[]>([]);
	query = $state('');
	project = $state<string | null>(null);
	visibleOrder = $derived(
		this.order.filter((id) => {
			const thread = this.threads.get(id);
			return (
				thread &&
				matchesThread(thread, { query: this.query, project: this.project })
			);
		}),
	);
	projects = $derived(projectOptions(this.threads.values()));
	clearFilters() {
		this.query = '';
		this.project = null;
	}
	selectedId = $state<string | null>(null);
	archivingId = $state<string | null>(null);
	archiveFailedId = $state<string | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	health = $state.raw<Health | null>(null);
	state = $state.raw<GatewayState | null>(null);
	flow = $state<Flow>('idle');
	status = $state('');
	recognizedText = $state('');
	draft = $state<{
		replyId: string;
		threadId: string;
		text: string;
		uncertain: boolean;
		bootId: string | null;
	} | null>(null);
	voiceOff = $state<string | null>(null);
	targetId = $state<string | null>(null);
	truncated = $state(false);
	transcripts = new SvelteMap<string, TranscriptState>();
	sent = new SvelteSet<string>();
	recorder = new VoiceRecorder({
		onError: (reason) => {
			this.voiceOff = reason;
			this.status = reason;
			this.flow = 'idle';
			this.targetId = null;
			this.recorder.cancel();
		},
	});
	#api: Api;
	#audio: { blob: Blob; mimeType: string } | null = null;
	#timer: ReturnType<typeof setInterval> | undefined;
	#bootId: string | null = null;
	#polling = false;
	#disposed = false;
	#flowGeneration = 0;
	#loads = new Map<string, number>();
	constructor({ api }: { api: Api }) {
		this.#api = api;
	}
	get selected() {
		return this.selectedId ? (this.threads.get(this.selectedId) ?? null) : null;
	}
	get transcript() {
		return this.selectedId ? this.transcripts.get(this.selectedId) : undefined;
	}
	get isBusy() {
		return this.isThreadBusy(
			this.targetId && this.flow !== 'idle' ? this.targetId : this.selectedId,
		);
	}
	isThreadBusy(id: string | null) {
		return (
			!!id &&
			(this.state?.live[id]?.status === 'inProgress' ||
				this.state?.live[id]?.threadStatus?.type === 'active' ||
				(!this.state?.live[id] &&
					this.threads.get(id)?.status.type === 'active'))
		);
	}
	get canArchive() {
		return (
			!!this.selectedId &&
			this.flow === 'idle' &&
			this.archivingId === null &&
			!this.isThreadBusy(this.selectedId) &&
			!this.state?.approvals.some(
				(approval) => approval.threadId === this.selectedId,
			)
		);
	}
	async archive() {
		const id = this.selectedId;
		if (!this.canArchive || !id || this.#disposed) return;
		const order = this.order;
		const title = this.threads.get(id)?.title ?? 'conversation';
		this.archivingId = id;
		this.archiveFailedId = null;
		this.status = `Archiving ${title}`;
		try {
			await this.#api.request<ArchiveResponse>(
				`/api/threads/${encodeURIComponent(id)}/archive`,
				{ method: 'POST' },
			);
			if (this.#disposed) return;
			this.threads.delete(id);
			this.order = this.order.filter((item) => item !== id);
			this.#loads.set(id, (this.#loads.get(id) ?? 0) + 1);
			this.transcripts.delete(id);
			this.sent.delete(id);
			const wasSelected = this.selectedId === id;
			const next = neighborId(order, new Set(this.visibleOrder), id, 1);
			if (wasSelected) this.select(next ?? null);
			this.status = `Archived ${title}${wasSelected && !next ? '. End of queue' : ''}`;
		} catch (error) {
			if (this.#disposed) return;
			this.archiveFailedId = id;
			this.status = `Could not archive: ${message(error)}`;
		} finally {
			this.archivingId = null;
		}
	}
	async start() {
		await Promise.all([this.reload(), this.#loadHealth(), this.poll()]);
		if (!this.#disposed)
			this.#timer = setInterval(() => {
				if (!document.hidden) void this.poll();
			}, 2500);
	}
	async #loadHealth() {
		try {
			this.health = await this.#api.request<Health>('/api/health');
			this.#bootId = this.health.bootId;
			if (!this.health.transcription.available)
				this.voiceOff = this.health.transcription.reason;
		} catch (error) {
			this.error = message(error);
		}
	}
	async reload() {
		if (this.loading || this.#disposed) return;
		this.loading = true;
		this.error = null;
		try {
			const response = await this.#api.request<ThreadsResponse>('/api/threads');
			const incoming = new Map(
				response.threads.map((thread) => [thread.id, thread]),
			);
			const existing = this.order.filter((id) => incoming.has(id));
			const fresh = response.threads
				.filter((thread) => !this.threads.has(thread.id))
				.map((thread) => thread.id);
			this.threads.clear();
			for (const [id, thread] of incoming) this.threads.set(id, thread);
			this.order = [...fresh, ...existing];
			this.truncated = response.truncated;
			if (
				!this.selectedId ||
				(!incoming.has(this.selectedId) && this.selectedId !== this.archivingId)
			)
				this.select(this.order[0] ?? null);
		} catch (error) {
			this.error = message(error);
		} finally {
			this.loading = false;
		}
	}
	select(id: string | null) {
		if (this.#disposed) return;
		this.selectedId = id;
		if (id && !this.transcripts.has(id)) void this.loadTurns(id);
	}
	next(fromId = this.selectedId) {
		const next = neighborId(this.order, new Set(this.visibleOrder), fromId, 1);
		if (next) {
			this.select(next);
			return true;
		}
		this.status = 'End of queue';
		return false;
	}
	previous() {
		const id = neighborId(
			this.order,
			new Set(this.visibleOrder),
			this.selectedId,
			-1,
		);
		if (id) this.select(id);
	}
	async loadTurns(id: string, earlier = false) {
		if (this.#disposed) return;
		const previous = this.transcripts.get(id);
		if (previous?.loading) return;
		const cursor = earlier ? previous?.data?.nextCursor : null;
		if (earlier && !cursor) return;
		const generation = (this.#loads.get(id) ?? 0) + 1;
		this.#loads.set(id, generation);
		this.transcripts.set(id, {
			loading: true,
			error: null,
			data: previous?.data ?? null,
		});
		try {
			const result = await this.#api.request<TurnsResponse>(
				`/api/threads/${encodeURIComponent(id)}/turns${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
			);
			if (this.#disposed || this.#loads.get(id) !== generation) return;
			const merged = earlier
				? [...result.turns, ...(previous?.data?.turns ?? [])]
				: result.turns;
			const seen = new Set<string>();
			this.transcripts.set(id, {
				loading: false,
				error: null,
				data: {
					...result,
					turns: merged.filter((turn) => {
						if (seen.has(turn.id)) return false;
						seen.add(turn.id);
						return true;
					}),
				},
			});
			if (this.transcripts.size > 12) {
				const oldest = [...this.transcripts.keys()].find(
					(key) => key !== this.selectedId && key !== id,
				);
				if (oldest) this.transcripts.delete(oldest);
			}
		} catch (error) {
			if (this.#disposed || this.#loads.get(id) !== generation) return;
			this.transcripts.set(id, {
				loading: false,
				error: message(error),
				data: previous?.data ?? null,
			});
		}
	}
	#invalidate(id: string) {
		this.#loads.set(id, (this.#loads.get(id) ?? 0) + 1);
		this.transcripts.delete(id);
		if (id === this.selectedId) void this.loadTurns(id);
	}
	async poll() {
		if (this.#polling || this.#disposed) return;
		this.#polling = true;
		try {
			const state = await this.#api.request<GatewayState>('/api/state');
			this.error = null;
			const previous = this.state;
			this.#bootId = state.bootId;
			this.state = state;
			if (previous) {
				for (const id of new Set([
					...Object.keys(previous.live),
					...Object.keys(state.live),
				])) {
					const before = previous.live[id];
					const after = state.live[id];
					if (
						before?.turnId !== after?.turnId ||
						before?.status !== after?.status
					)
						this.#invalidate(id);
				}
			}
			if (state.appServer.state === 'down') await this.#loadHealth();
		} catch (error) {
			this.error = message(error);
		} finally {
			this.#polling = false;
		}
	}
	async toggleRecord() {
		if (this.archivingId !== null || this.#disposed) return;
		if (this.flow === 'recording') {
			await this.stopAndSend();
			return;
		}
		if (this.flow !== 'idle' || !this.selectedId || this.isBusy) return;
		this.targetId = this.selectedId;
		this.recognizedText = '';
		this.status = 'Requesting microphone access';
		const generation = ++this.#flowGeneration;
		this.flow = 'recording';
		try {
			await this.recorder.start();
			if (generation !== this.#flowGeneration) return;
			this.status = `Recording for ${this.threads.get(this.targetId)?.title ?? 'conversation'}`;
		} catch (error) {
			if (generation !== this.#flowGeneration) return;
			this.voiceOff = message(error);
			this.status = this.voiceOff;
			this.flow = 'idle';
			this.targetId = null;
		}
	}
	async stopAndSend() {
		if (this.flow !== 'recording' || !this.recorder.isRecording) return;
		this.flow = 'transcribing';
		try {
			this.#audio = await this.recorder.stop();
		} catch (error) {
			this.voiceOff = message(error);
			this.flow = 'idle';
			this.status = this.voiceOff;
			return;
		}
		await this.retryTranscription();
	}
	async retryTranscription() {
		if (!this.#audio || !this.targetId || this.#disposed) return;
		this.flow = 'transcribing';
		this.status = 'Transcribing locally';
		try {
			const result = await this.#api.request<TranscriptionResponse>(
				'/api/transcribe',
				{
					method: 'POST',
					headers: { 'Content-Type': this.#audio.mimeType },
					body: this.#audio.blob,
				},
			);
			if (this.#disposed) return;
			this.recognizedText = result.text;
			if (!result.text.trim()) {
				this.status = 'No speech detected. Record again or type a message.';
				this.flow = 'idle';
				this.#audio = null;
				this.targetId = null;
				return;
			}
			await this.send();
		} catch (error) {
			this.flow = 'transcribeFailed';
			this.status = message(error);
		}
	}
	async sendText() {
		if (
			this.archivingId !== null ||
			this.flow !== 'idle' ||
			!this.selectedId ||
			this.isBusy ||
			!this.recognizedText.trim()
		)
			return;
		this.targetId = this.selectedId;
		await this.send();
	}
	async send() {
		if (this.#disposed) return;
		const id = this.targetId;
		if (
			!id ||
			!this.recognizedText.trim() ||
			!['idle', 'transcribing', 'sendFailed'].includes(this.flow)
		)
			return;
		if (
			!this.draft ||
			(!this.draft.uncertain && this.draft.text !== this.recognizedText.trim())
		) {
			this.draft = {
				replyId: crypto.randomUUID(),
				threadId: id,
				text: this.recognizedText.trim(),
				uncertain: false,
				bootId:
					this.#bootId ?? this.state?.bootId ?? this.health?.bootId ?? null,
			};
		}
		const draft = this.draft;
		if (!draft.uncertain && this.isThreadBusy(id)) {
			this.flow = 'sendFailed';
			this.status = 'Codex is working on this conversation';
			return;
		}
		this.flow = 'sending';
		this.status = `Sending to ${this.threads.get(id)?.title ?? 'conversation'}`;
		try {
			const response = await this.#api.request<SendResponse>(
				`/api/threads/${encodeURIComponent(id)}/turns`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						text: draft.text,
						replyId: draft.replyId,
						...(draft.uncertain
							? { retry: true, bootId: draft.bootId ?? undefined }
							: {}),
					}),
				},
			);
			if (this.#disposed) return;
			this.#invalidate(id);
			this.sent.add(id);
			const current = this.state ?? {
				bootId: this.health?.bootId ?? '',
				appServer: { state: 'ready', lastError: null },
				live: {},
				approvals: [],
				notices: [],
			};
			this.state = {
				...current,
				live: {
					...current.live,
					[id]: {
						turnId: response.turnId,
						status: response.status,
						startedAt: Date.now() / 1000,
						completedAt: null,
						error: null,
						lastAgentMessage: '',
						threadStatus: null,
					},
				},
			};
			const wasSelected = this.selectedId === id;
			const advanced = wasSelected && this.next(id);
			this.status = `Sent to ${this.threads.get(id)?.title ?? 'conversation'}${wasSelected && !advanced ? '. End of queue' : ''}`;
			this.flow = 'idle';
			this.recognizedText = '';
			this.draft = null;
			this.targetId = null;
			this.#audio = null;
		} catch (error) {
			if (this.#disposed) return;
			if (error instanceof ApiError && error.code === 'outcome_unknown') {
				this.flow = 'sendUnknown';
				this.status =
					'Codex may already have this reply. The gateway could not confirm delivery.';
				return;
			}
			this.flow = 'sendFailed';
			if (error instanceof ApiError && error.definite) {
				this.status = message(error);
				if (error.code === 'reply_conflict') this.draft = null;
			} else {
				this.draft = { ...draft, uncertain: true };
				this.status =
					'No answer from the gateway. Retrying is safe: the gateway ignores a repeat of this reply.';
			}
		}
	}
	async checkConversation() {
		const draft = this.draft;
		if (this.flow !== 'sendUnknown' || !draft) return;
		this.flow = 'checking';
		try {
			const result = await this.#api.request<TurnsResponse>(
				`/api/threads/${encodeURIComponent(draft.threadId)}/turns`,
			);
			if (this.#disposed) return;
			this.#invalidate(draft.threadId);
			if (
				result.turns.some((turn) =>
					turn.items.some(
						(item) =>
							item.type === 'userMessage' &&
							'clientId' in item &&
							item.clientId === draft.replyId,
					),
				)
			) {
				this.sent.add(draft.threadId);
				this.draft = null;
				this.recognizedText = '';
				this.targetId = null;
				this.#audio = null;
				this.flow = 'idle';
				this.status = 'Found in the conversation: delivered';
			} else {
				this.flow = 'sendUnknown';
				this.status =
					'Not in the latest turns. It may still arrive; check again, or send it as a new message.';
			}
		} catch (error) {
			this.flow = 'sendUnknown';
			this.status = message(error);
		}
	}
	async sendAsNew() {
		if (this.flow !== 'sendUnknown') return;
		this.draft = null;
		this.flow = 'sendFailed';
		await this.send();
	}

	discard() {
		if (['transcribing', 'sending', 'checking'].includes(this.flow)) return;
		this.#flowGeneration++;
		this.recorder.cancel();
		this.flow = 'idle';
		this.targetId = null;
		this.#audio = null;
		this.recognizedText = '';
		this.draft = null;
		this.status = 'Discarded';
	}
	async decideApproval(id: string, decision: 'accept' | 'decline') {
		await this.#api.request(`/api/approvals/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ decision }),
		});
		await this.poll();
	}

	dispose() {
		this.#disposed = true;
		this.#flowGeneration++;
		clearInterval(this.#timer);
		this.recorder.cancel();
	}
}

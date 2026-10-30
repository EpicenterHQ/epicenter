export class VoiceRecorder {
	isRecording = $state(false);
	error = $state<string | null>(null);
	#recorder: MediaRecorder | null = null;
	#stream: MediaStream | null = null;
	#chunks: Blob[] = [];
	#generation = 0;
	#onError: (reason: string) => void;
	constructor({
		onError = () => {},
	}: { onError?: (reason: string) => void } = {}) {
		this.#onError = onError;
	}
	async start() {
		this.error = null;
		if (!window.isSecureContext)
			throw new Error(
				'Microphone requires a secure context. Use HTTPS or localhost.',
			);
		if (!navigator.mediaDevices?.getUserMedia)
			throw new Error('Microphone access is unavailable in this browser.');
		if (typeof MediaRecorder === 'undefined')
			throw new Error('Audio recording is unavailable in this browser.');
		const generation = ++this.#generation;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (generation !== this.#generation) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			this.#stream = stream;
			const mimeType = [
				'audio/webm;codecs=opus',
				'audio/ogg;codecs=opus',
				'audio/mp4',
			].find((type) => MediaRecorder.isTypeSupported(type));
			const recorder = new MediaRecorder(
				stream,
				mimeType ? { mimeType } : undefined,
			);
			this.#recorder = recorder;
			this.#chunks = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size) this.#chunks.push(event.data);
			};
			recorder.onerror = () => {
				this.error =
					'Audio recording failed. Check microphone access and try again.';
				this.isRecording = false;
				for (const track of stream.getTracks()) track.stop();
				this.#onError(this.error);
			};
			recorder.start();
			this.isRecording = true;
		} catch (error) {
			this.cancel();
			if (error instanceof DOMException) {
				if (error.name === 'NotAllowedError')
					throw new Error(
						'Microphone permission was denied. Allow microphone access in your browser settings.',
					);
				if (error.name === 'NotFoundError')
					throw new Error(
						'No microphone was found. Connect a microphone to use voice.',
					);
				if (error.name === 'NotReadableError')
					throw new Error(
						'Microphone cannot be read. Another application may be using it.',
					);
			}
			throw error;
		}
	}
	async stop(): Promise<{ blob: Blob; mimeType: string }> {
		const recorder = this.#recorder;
		if (!recorder || recorder.state === 'inactive')
			throw new Error(this.error ?? 'No recording is active');
		return new Promise((resolve, reject) => {
			recorder.onstop = () => {
				const mimeType = recorder.mimeType || 'audio/webm';
				const blob = new Blob(this.#chunks, { type: mimeType });
				this.cancel();
				resolve({ blob, mimeType });
			};
			recorder.onerror = () => {
				this.cancel();
				reject(new Error('Audio recording failed'));
			};
			recorder.stop();
			this.isRecording = false;
		});
	}
	cancel() {
		this.#generation++;
		if (this.#recorder?.state === 'recording') this.#recorder.stop();
		for (const track of this.#stream?.getTracks() ?? []) track.stop();
		this.#recorder = null;
		this.#stream = null;
		this.#chunks = [];
		this.isRecording = false;
	}
}

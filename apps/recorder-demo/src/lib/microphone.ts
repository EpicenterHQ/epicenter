/**
 * The microphone a recording comes from: the real one, or under
 * `?fixture=tone` a 440 Hz oscillator, for browsers under test that have no
 * fake capture device (WebKit under Playwright). The tone needs no
 * permission.
 */
export function toneStream(): MediaStream {
	const context = new AudioContext();
	const oscillator = context.createOscillator();
	oscillator.frequency.value = 440;
	const destination = context.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	const { stream } = destination;
	// Stopping the recording's tracks also stops the tone.
	for (const track of stream.getTracks())
		track.addEventListener('ended', () => void context.close());
	return stream;
}

/** The microphone this page records from: the tone under `?fixture=tone`, else the real one. */
export async function openMicrophone(): Promise<MediaStream> {
	if (new URL(location.href).searchParams.get('fixture') === 'tone')
		return toneStream();
	return navigator.mediaDevices.getUserMedia({ audio: true });
}

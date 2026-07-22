import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	DesktopRecordNativeCaptureResolution,
	DesktopRecordNativeCaptureResolver,
} from '@epicenter/data/desktop-record-owner';

const NATIVE_CAPTURE_ID = /^capture_[a-f0-9]{32}$/u;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Resolve Rust-owned recording captures without exposing a path to a WebView.
 * The no-follow descriptor pins the regular file and declared length that Data
 * admits. Rust retains the durable manifest and owns deletion after admission.
 */
export function createNativeRecordingCaptureResolver(
	directory: string,
): DesktopRecordNativeCaptureResolver {
	return async (capture) => resolveCapture(directory, capture);
}

async function resolveCapture(
	directory: string,
	capture: Parameters<DesktopRecordNativeCaptureResolver>[0],
): Promise<DesktopRecordNativeCaptureResolution> {
	if (!NATIVE_CAPTURE_ID.test(capture.captureId)) {
		throw new TypeError('Native recording capture ID is invalid');
	}
	const path = join(directory, `${capture.captureId}.wav`);
	if (constants.O_NOFOLLOW === undefined || constants.O_NOFOLLOW === 0) {
		throw new Error('Native recording captures require no-follow file opens');
	}
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	).catch((cause) => {
		throw new Error('Native recording capture is unavailable', { cause });
	});
	const opened = await file.stat().catch(async (cause) => {
		await file.close().catch(() => undefined);
		throw new Error('Native recording capture could not be inspected', {
			cause,
		});
	});
	if (!opened.isFile() || opened.size !== capture.byteLength) {
		await file.close();
		throw new Error('Native recording capture changed before admission');
	}

	let isClosed = false;
	async function close(): Promise<void> {
		if (isClosed) return;
		isClosed = true;
		await file.close();
	}

	async function* source(): AsyncIterable<Uint8Array> {
		const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let position = 0;
		try {
			while (true) {
				const { bytesRead } = await file.read(
					buffer,
					0,
					buffer.byteLength,
					position,
				);
				if (bytesRead === 0) return;
				position += bytesRead;
				yield new Uint8Array(buffer.subarray(0, bytesRead));
			}
		} finally {
			await close();
		}
	}

	return {
		source: source(),
		async release() {
			await close();
		},
	};
}

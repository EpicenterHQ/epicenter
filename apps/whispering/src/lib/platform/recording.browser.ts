import { createBrowserRecording } from '@epicenter/recorder/browser';
import type { RecordingFactory } from '@epicenter/recorder/recording';

export const recording: RecordingFactory = createBrowserRecording;

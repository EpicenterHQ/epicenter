import { createDesktopRecording } from '@epicenter/recorder/desktop';
import type { RecordingFactory } from '@epicenter/recorder/recording';

export const recording: RecordingFactory = createDesktopRecording;

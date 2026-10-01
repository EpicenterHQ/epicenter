import { invoke } from '@tauri-apps/api/core';

export const CAPTURE_PROMOTION_AVAILABLE = true;

export function setCaptureWindowVisible(reveal: boolean): Promise<void> {
	return invoke('set_capture_window_visible', { reveal });
}

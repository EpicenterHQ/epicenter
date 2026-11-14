Help me rethink a photo-import API from first principles. This is conceptual exploration, not implementation. Don't let the current proposal or migration cost determine the destination.

People import photos from a phone, a local folder, and an archive export. They often select overlapping sets at different times. A selection can contain 80,000 files, including large videos. Closing the screen or restarting the application must not lose completed work or the person's decisions. Some sources are removable drives; browser selections may require the person to grant access again after restart. Do not assume an operating-system path is a durable credential.

The product must preserve every distinct original byte sequence, avoid storing identical bytes repeatedly, and preserve source provenance including different filenames and capture metadata. Equal bytes can appear under different names; the same filename can refer to different bytes. A photo that cannot be decoded still needs its original preserved and a visible problem report. People want to start using successfully imported items while the rest continues. They can pause, cancel remaining work, retry failures, and later reselect a source. Cancellation must not silently delete items already imported. A failed preview is not proof that the original failed to copy.

The current proposal is:

type ImportSession = {
  id: string;
  sourceId: string;
  manifestId: string;
  status: 'selected' | 'scanning' | 'copying' | 'processing' | 'ready' | 'failed' | 'cancelled';
  entries: ImportEntry[];
};

type ImportEntry = {
  id: string;
  sourcePath: string;
  destinationPath?: string;
  copyStatus: 'pending' | 'copying' | 'copied' | 'failed';
  decodeStatus: 'pending' | 'processing' | 'done' | 'failed';
  duplicateOf?: string;
};

The implementation sketch puts SourceRegistry, ManifestStore, CopyQueue, DuplicateIndex, PreviewQueue, and ImportSessionStore behind an ImportManager. Each queue persists its progress and sends completion callbacks to the manager. A separate AssetStore owns imported files and MetadataStore owns their interpretation. No implementation exists yet; these are proposed boundaries, not requirements.

Different consumers need a progress screen, a library grid that displays usable imported items, a source-reconnection prompt, and per-file diagnostics. A background process may continue work while none of those screens is mounted. Raw source metadata should remain available even if the current parser does not understand it.

Develop the strongest coherent greenfield model and API. Show natural use and a realistic UI interaction. Follow a batch through partial success, restart with a missing source, reselecting overlapping files, a preview failure after a successful copy, and cancellation followed by retry. Define what an import's completion promises. Explain the information and responsibilities that belong together, what disappears, what new work or concepts you introduce, and which user guarantees justify them. You may challenge explicit requirements as clearly labeled proposals, but do not silently discard them.

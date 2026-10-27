// PROTOTYPE: Whispering-shaped files (5 tables), as path -> { fields, body }.
const text = (label, size) => (label + '\n' + 'The meeting covered the product design, next steps, and open questions. '.repeat(Math.ceil(size / 68))).slice(0, size) + '\n';
export function fixture(count) {
  const files = new Map(), createdAt = '2026-10-27T04:00:00.000Z';
  for (let i = 0; i < count; i++) {
    const id = `20261027-120000-${String(i).padStart(6, '0')}`;
    files.set(`recordings/${id}.md`, { fields: { title: `Recording ${i}`, recordedAt: createdAt, durationMs: 45000 + i, capture: 'microphone' }, body: text(`Notes ${i}`, 150) });
    files.set(`transcriptions/${id}.md`, { fields: { recordingId: id, createdAt, model: 'whisper-1', endpoint: 'https://example.invalid/transcribe' }, body: text(`Transcript ${i}`, 3000) });
    files.set(`transformations/${id}.md`, { fields: { title: `Recipe ${i}`, model: null }, body: text(`Instructions ${i}`, 600) });
    files.set(`transformation_runs/${id}.md`, { fields: { recordingId: id, transcriptionId: id, transformationId: id, transformationTitle: `Recipe ${i}`, createdAt, model: 'example-model', endpoint: 'https://example.invalid/text', prompt: text(`Prompt ${i}`, 400), input: text(`Input ${i}`, 3000) }, body: text(`Output ${i}`, 1800) });
    files.set(`text_runs/${id}.md`, { fields: { transformationId: id, transformationTitle: `Recipe ${i}`, createdAt, model: 'example-model', endpoint: 'https://example.invalid/text', prompt: text(`Prompt ${i}`, 400), input: text(`Pasted input ${i}`, 2500) }, body: text(`Text output ${i}`, 1800) });
  }
  return files;
}

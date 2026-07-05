// A tool is just a plain function — it knows nothing about LLMs.
// The tool-registry describes it to the model and dispatches to it.
export function getCurrentTime(): string {
  return new Date().toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
  });
}

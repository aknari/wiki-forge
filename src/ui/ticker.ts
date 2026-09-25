/**
 * Repeats a label with the seconds elapsed — `Thinking… 12s` — until stopped.
 *
 * One note is a model call that can take a minute, the panel does not move while
 * it runs, and a Notice has faded by the time anyone wonders whether it is still
 * working. A counter is the cheapest honest signal there is: a slow call and a
 * stuck one stop looking the same.
 */
export function startTicker(render: (seconds: number) => void): () => void {
  const started = Date.now();
  render(0);
  const id = window.setInterval(() => render(Math.round((Date.now() - started) / 1000)), 1000);
  return () => window.clearInterval(id);
}

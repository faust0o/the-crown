/**
 * Call `fn` `fps` times a second, from a worker's clock so a hidden tab does
 * not slow it down — see `ticker.worker.ts`. Falls back to the page's own
 * timer where a worker cannot start. Returns the function that stops it.
 */
export function tick(fps: number, fn: () => void): () => void {
  let fallback: ReturnType<typeof setInterval> | undefined;
  const startTimer = () => {
    clearInterval(fallback);
    fallback = setInterval(fn, 1000 / fps);
  };

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./ticker.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = fn;
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      startTimer();
    };
    worker.postMessage(fps);
  } catch {
    startTimer();
  }

  return () => {
    worker?.terminate();
    clearInterval(fallback);
  };
}

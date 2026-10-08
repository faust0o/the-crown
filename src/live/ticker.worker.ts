/**
 * A metronome off the main thread.
 *
 * A page's own timers are throttled to once a second when its tab is hidden,
 * and to once a minute after a while; a worker's are not. The stream's frames
 * are painted on these ticks, so a broadcast keeps moving when the operator
 * looks at another tab.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<number>) => void) | null;
  postMessage: (message: unknown) => void;
};

let timer: ReturnType<typeof setInterval> | undefined;

scope.onmessage = (e) => {
  clearInterval(timer);
  if (e.data > 0) timer = setInterval(() => scope.postMessage(0), 1000 / e.data);
};

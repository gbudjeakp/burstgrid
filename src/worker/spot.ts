import http from 'node:http';

const IMDS_TERMINATION_URL = 'http://169.254.169.254/latest/meta-data/spot/termination-time';
const POLL_INTERVAL_MS = 5_000;

/** GET the IMDS spot termination endpoint; resolves to true if termination is imminent. */
function checkTermination(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(IMDS_TERMINATION_URL, { timeout: 2_000 }, res => {
      // 200 means a termination time is set; 404 means no pending termination
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Polls the EC2 instance metadata service every 5 s for a spot termination notice.
 * When the 2-minute warning fires, aborts the returned signal so the worker can drain
 * gracefully before the instance is reclaimed.
 *
 * On non-EC2 hosts the IMDS call always returns ECONNREFUSED, so this is a no-op.
 */
export function watchSpotTermination(parentSignal: AbortSignal): AbortSignal {
  const controller = new AbortController();

  if (parentSignal.aborted) {
    controller.abort();
    return controller.signal;
  }

  const timer = setInterval(async () => {
    if (parentSignal.aborted || controller.signal.aborted) {
      clearInterval(timer);
      return;
    }
    const terminating = await checkTermination();
    if (terminating) {
      console.warn('[spot] EC2 spot termination notice received — triggering graceful drain');
      clearInterval(timer);
      controller.abort();
    }
  }, POLL_INTERVAL_MS);

  // Don't keep the process alive just for polling
  timer.unref();

  parentSignal.addEventListener('abort', () => {
    clearInterval(timer);
    controller.abort();
  }, { once: true });

  return controller.signal;
}

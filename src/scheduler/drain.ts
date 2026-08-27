import type { JobQueue } from './queue.js';
import type { JobMetaCache } from './job-meta-cache.js';

/** Resolves once both the queue and the in-flight cache reach zero. */
export function awaitDrain(queue: JobQueue, cache: JobMetaCache): Promise<void> {
  return new Promise(resolve => {
    let qDrained = queue.depth === 0;
    let cDrained = cache.size === 0;
    const check = () => { if (qDrained && cDrained) resolve(); };
    if (!qDrained) queue.once('drain', () => { qDrained = true; check(); });
    if (!cDrained) cache.once('drain', () => { cDrained = true; check(); });
    check();
  });
}

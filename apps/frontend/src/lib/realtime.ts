import { eventsUrl, tokenStore } from '../api/client';

export type RealtimeStatus = 'connecting' | 'live' | 'offline';

export interface PlatformEvent {
  type: 'job.updated' | 'asset.updated' | 'asset.created' | 'asset.changed' | 'asset.deleted' | 'library.changed';
  assetId?: string; jobId?: string; status?: string; scope?: 'assets' | 'collections' | 'tags' | 'shares';
}

/**
 * Consumes the API's Server-Sent Events stream with fetch() streaming.
 *
 * The browser's EventSource cannot send an Authorization header, and putting
 * the JWT in the URL would leak it into proxy and access logs. fetch() can
 * send the header, so we parse the (simple) SSE framing ourselves.
 *
 * Events are only "something changed, refetch" hints - the database stays the
 * source of truth - so the failure mode of a dropped connection is a slightly
 * late refresh, never wrong data. On every (re)connect we ask the caller to
 * refetch everything to cover anything missed while disconnected.
 */
export function startRealtime(handlers: {
  onEvent: (e: PlatformEvent) => void;
  onStatus: (s: RealtimeStatus) => void;
  onConnected: () => void;
}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    const token = tokenStore.get();
    if (!token || stopped) return;
    handlers.onStatus('connecting');
    controller = new AbortController();
    try {
      const res = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      attempt = 0;
      handlers.onStatus('live');
      handlers.onConnected();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          parseFrame(frame);
        }
      }
    } catch {
      /* fall through to reconnect */
    }
    if (stopped) return;
    handlers.onStatus('offline');
    attempt++;
    // Exponential backoff with jitter so a server restart isn't followed by a thundering herd.
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)) * (0.7 + Math.random() * 0.6);
    timer = setTimeout(run, delay);
  }

  function parseFrame(frame: string) {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (event !== 'platform' || data.length === 0) return; // ready / ping
    try {
      const envelope = JSON.parse(data.join('\n'));
      if (envelope?.event) handlers.onEvent(envelope.event as PlatformEvent);
    } catch { /* ignore malformed frame */ }
  }

  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}

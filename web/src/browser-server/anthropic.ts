/**
 * One Anthropic Messages API call from the browser (hosted build, user's own key), streaming so
 * long agent answers never time out. Returns JSON text: {ok, stop_reason, text} or
 * {ok: false, status, error}. The text is the answer after any fallback-model switch.
 *
 * Like the Anthropic SDK on the server, it retries what is worth retrying: a dropped connection
 * or interrupted stream, rate limits, overload and server errors (up to 3 attempts, with a pause).
 * It never throws: every failure comes back as {ok: false} with the reason.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const API = 'https://api.anthropic.com/v1/messages';

const RETRY_STATUS = new Set([0, 408, 409, 429, 500, 502, 503, 504, 529]);
const ATTEMPTS = 3;

type Result =
  { ok: true; stop_reason: string | null; text: string } | { ok: false; status: number; error: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callAnthropic(
  aiKey: string | null,
  body: string,
  fetchImpl: typeof fetch = fetch,
  pauseMs = (attempt: number) => 5000 * 4 ** (attempt - 1), // 5 s, 20 s
): Promise<string> {
  if (!aiKey) return JSON.stringify({ ok: false, status: 401, error: 'No API key in this browser.' });
  let last: Result = { ok: false, status: 0, error: 'not called' };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await once(aiKey, body, fetchImpl);
    if (last.ok || !RETRY_STATUS.has(last.status)) break;
    if (attempt < ATTEMPTS) await wait(pauseMs(attempt));
  }
  if (!last.ok && RETRY_STATUS.has(last.status))
    last = { ...last, error: `${last.error} (after ${ATTEMPTS} attempts)` };
  return JSON.stringify(last);
}

async function once(aiKey: string, body: string, fetchImpl: typeof fetch): Promise<Result> {
  let res: Response;
  try {
    res = await fetchImpl(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': aiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    });
  } catch (err: any) {
    return { ok: false, status: 0, error: `Network error: ${err?.message ?? err}` };
  }
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 600);
    } catch {
      // body unreadable: the status says enough
    }
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
  }
  // Server-sent events: collect the text of the answer (after any fallback switch).
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text: string[] = [];
  const kinds: string[] = [];
  let stop: string | null = null;
  let streamError: { status: number; error: string } | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let d: any;
        try {
          d = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (d.type === 'content_block_start') {
          kinds[d.index] = d.content_block?.type;
          if (d.content_block?.type === 'fallback') text = []; // a fallback model took over
        } else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
          text[d.index] = (text[d.index] ?? '') + d.delta.text;
        } else if (d.type === 'message_delta' && d.delta?.stop_reason) {
          stop = d.delta.stop_reason;
        } else if (d.type === 'error') {
          // overloaded_error etc. arrive inside the stream
          const kind = d.error?.type ?? '';
          streamError = {
            status: kind === 'overloaded_error' ? 529 : kind === 'rate_limit_error' ? 429 : 500,
            error: d.error?.message ?? 'stream error',
          };
        }
      }
    }
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: `The connection dropped during the answer: ${err?.message ?? err}`,
    };
  }
  if (streamError) return { ok: false, ...streamError };
  if (stop === null) return { ok: false, status: 0, error: 'The answer stopped before it was complete.' };
  const answer = text.filter((t, i) => t !== undefined && kinds[i] === 'text').join('');
  return { ok: true, stop_reason: stop, text: answer };
}

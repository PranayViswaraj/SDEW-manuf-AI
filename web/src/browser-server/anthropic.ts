/**
 * One Anthropic Messages API call from the browser (hosted build, user's own key), streaming so
 * long agent answers never time out. Returns JSON text: {ok, stop_reason, text} or
 * {ok: false, status, error}. The text is the answer after any fallback-model switch.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const API = 'https://api.anthropic.com/v1/messages';

export async function callAnthropic(
  aiKey: string | null,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!aiKey) return JSON.stringify({ ok: false, status: 401, error: 'No API key in this browser.' });
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
    return JSON.stringify({ ok: false, status: 0, error: `Network error: ${err?.message ?? err}` });
  }
  if (!res.ok || !res.body) {
    return JSON.stringify({ ok: false, status: res.status, error: (await res.text()).slice(0, 600) });
  }
  // Server-sent events: collect the text of the answer (after any fallback switch).
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text: string[] = [];
  const kinds: string[] = [];
  let stop: string | null = null;
  let error: string | null = null;
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
        error = d.error?.message ?? 'stream error';
      }
    }
  }
  if (error) return JSON.stringify({ ok: false, status: 500, error });
  const answer = text.filter((t, i) => t !== undefined && kinds[i] === 'text').join('');
  return JSON.stringify({ ok: true, stop_reason: stop, text: answer });
}

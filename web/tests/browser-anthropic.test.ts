import { API, callAnthropic } from '../src/browser-server/anthropic';

function sse(events: object[], splitEvery = 37): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= text.length) return c.close();
      c.enqueue(enc.encode(text.slice(i, i + splitEvery))); // chunks cut mid-event
      i += splitEvery;
    },
  });
}

type Reply = [number, ReadableStream<Uint8Array> | string] | 'drop';

function fakeFetch(status: number, body: ReadableStream<Uint8Array> | string, ...more: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: Reply[] = [[status, body], ...more];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r === 'drop') {
      // headers arrive, then the connection breaks in the middle of the answer
      let sent = false;
      const broken = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(new TextEncoder().encode(`event: ping${'\n'}data: {"type":"ping"}${'\n\n'}`));
          } else c.error(new TypeError('network error'));
        },
      });
      return new Response(broken, { status: 200 });
    }
    return new Response(r[1], { status: r[0] });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const now = () => 0;

describe('Anthropic call from the browser (own key)', () => {
  it('streams the answer, skipping thinking and anything before a fallback switch', async () => {
    const { impl, calls } = fakeFetch(
      200,
      sse([
        { type: 'message_start', message: { id: 'm1' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"half' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'fallback' } },
        { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '{"verdict":' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '"accept"}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );
    const out = JSON.parse(await callAnthropic('sk-ant-test', '{"model":"m"}', impl, now));
    expect(out).toEqual({ ok: true, stop_reason: 'end_turn', text: '{"verdict":"accept"}' });
    expect(calls[0].url).toBe(API);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('reports a rejected key and a missing key without calling', async () => {
    const bad = fakeFetch(401, '{"error":{"type":"authentication_error"}}');
    expect(JSON.parse(await callAnthropic('sk-ant-bad', '{}', bad.impl, now))).toMatchObject({
      ok: false,
      status: 401,
    });
    const none = fakeFetch(200, '');
    expect(JSON.parse(await callAnthropic(null, '{}', none.impl, now))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(none.calls).toHaveLength(0);
  });

  it('reports an error event in the stream', async () => {
    const busy = () => sse([{ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }]);
    const { impl, calls } = fakeFetch(200, busy(), [200, busy()], [200, busy()]);
    expect(JSON.parse(await callAnthropic('sk-ant-x', '{}', impl, now))).toMatchObject({
      ok: false,
      status: 529,
      error: 'overloaded (after 3 attempts)',
    });
    expect(calls).toHaveLength(3);
  });

  it('retries a connection that drops mid-answer, and an answer cut short', async () => {
    const good = (): ReadableStream<Uint8Array> =>
      sse([
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ]);
    const cut = sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }]);
    const { impl, calls } = fakeFetch(200, cut, 'drop', [200, good()]);
    const out = JSON.parse(await callAnthropic('sk-ant-x', '{}', impl, now));
    expect(out).toEqual({ ok: true, stop_reason: 'end_turn', text: '{}' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a rejected key', async () => {
    const { impl, calls } = fakeFetch(401, 'invalid x-api-key');
    const out = JSON.parse(await callAnthropic('sk-ant-x', '{}', impl, now));
    expect(out).toMatchObject({ ok: false, status: 401, error: 'invalid x-api-key' });
    expect(calls).toHaveLength(1);
  });
});

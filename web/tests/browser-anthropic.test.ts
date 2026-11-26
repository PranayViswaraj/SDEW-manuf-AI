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

function fakeFetch(status: number, body: ReadableStream<Uint8Array> | string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

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
    const out = JSON.parse(await callAnthropic('sk-ant-test', '{"model":"m"}', impl));
    expect(out).toEqual({ ok: true, stop_reason: 'end_turn', text: '{"verdict":"accept"}' });
    expect(calls[0].url).toBe(API);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('reports a rejected key and a missing key without calling', async () => {
    const bad = fakeFetch(401, '{"error":{"type":"authentication_error"}}');
    expect(JSON.parse(await callAnthropic('sk-ant-bad', '{}', bad.impl))).toMatchObject({
      ok: false,
      status: 401,
    });
    const none = fakeFetch(200, '');
    expect(JSON.parse(await callAnthropic(null, '{}', none.impl))).toMatchObject({ ok: false, status: 401 });
    expect(none.calls).toHaveLength(0);
  });

  it('reports an error event in the stream', async () => {
    const { impl } = fakeFetch(200, sse([{ type: 'error', error: { message: 'overloaded' } }]));
    expect(JSON.parse(await callAnthropic('sk-ant-x', '{}', impl))).toMatchObject({
      ok: false,
      error: 'overloaded',
    });
  });
});

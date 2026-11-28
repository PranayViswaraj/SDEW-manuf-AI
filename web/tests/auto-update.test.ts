import { watchForUpdate } from '../src/hooks/useAutoUpdate';
import { setBusy } from '../src/lib/busy';

const reply = (build: string) => async () => new Response(JSON.stringify({ build }));

describe('open tabs follow a new deploy', () => {
  afterEach(() => {
    setBusy('ai-read', false);
    vi.useRealTimers();
  });

  it('reloads when a newer build is deployed and nothing is running', async () => {
    const reload = vi.fn();
    const stop = watchForUpdate({ build: 'old', fetchImpl: reply('new'), reload });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    stop();
  });

  it('does nothing on the same build', async () => {
    const reload = vi.fn();
    const fetchImpl = vi.fn(reply('same'));
    const stop = watchForUpdate({ build: 'same', fetchImpl, reload });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it('waits for a running AI read before reloading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setBusy('ai-read', true);
    const reload = vi.fn();
    const stop = watchForUpdate({ build: 'old', fetchImpl: reply('new'), reload });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reload).not.toHaveBeenCalled();
    setBusy('ai-read', false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });
});

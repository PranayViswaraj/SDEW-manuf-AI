import { render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../src/api/client';
import type { AiJob } from '../src/api/types';
import AiReadPanel from '../src/components/AiReadPanel';

const base = {
  part_number: '3227C07701',
  title: 'drawing.pdf',
  read_by: 'AI (extractor + verifier)',
  not_on_drawing: [],
  not_in_table: ['Face groove on the flange face'],
  filled: false,
  message: '',
};

function job(p: Partial<AiJob>): AiJob {
  return {
    id: 'j1',
    part_number: '3227C07701',
    status: 'running',
    stage: 'extract',
    round: 0,
    elapsed: 3,
    info: base,
    ...p,
  };
}

describe('two-agent AI read panel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows agent 1 then agent 2 working, then the checked result with the 3D analysis', async () => {
    const done = job({
      status: 'done',
      stage: 'done',
      round: 1,
      elapsed: 74,
      info: {
        ...base,
        filled: true,
        message: 'The AI read this drawing.',
        verify_rounds: 1,
        check_counts: { ok: 14, wrong: 2, unsupported: 0, unclear: 1 },
        shape_3d: {
          summary: 'Stepped hollow boss with a flange and a face groove',
          max_diameter: 38,
          length: 62,
          ends: ['small end: Ø22.22 spigot'],
          non_turned: [],
        },
        feature_list: ['Front face', 'Ø22.22 ±0.1 spigot, 34 long', 'Ø19 bore through'],
        callouts: 31,
        usage: { calls: 2, input: 6000, output: 41000, cache_write: 30000, cache_read: 30000, cost_usd: 1.0 },
        balloons: 14,
        unaccounted: ['Balloon 9 not found on the drawing by the AI'],
      },
    });
    const replies = [job({}), job({ stage: 'verify', round: 1, elapsed: 40 }), done];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'get').mockImplementation(async () => replies.shift() ?? done);
    const onDone = vi.fn();
    render(<AiReadPanel jobId="j1" onDone={onDone} onLost={vi.fn()} />);

    expect(await screen.findByText(/Reading the drawing as an image/)).toBeInTheDocument();
    expect(screen.getByText('Starts when agent 1 hands over its draft.')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1300);
    expect(await screen.findByText(/Checking every value against the drawing/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1300);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(done.info, true));
    expect(
      await screen.findByText('Stepped hollow boss with a flange and a face groove'),
    ).toBeInTheDocument();
    expect(screen.getByText('Ø22.22 ±0.1 spigot, 34 long')).toBeInTheDocument();
    expect(screen.getByText('Corrected')).toBeInTheDocument();
    expect(
      screen.getByText(/31 callouts read, balloons 1–14 · 1 to check on the drawing/),
    ).toBeInTheDocument();
    expect(screen.getByText('Balloon 9 not found on the drawing by the AI')).toBeInTheDocument();
    expect(
      screen.getByText(/Used 2 AI calls · 66k tokens in \(30k from cache\) · 41k tokens out/),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('reports a failed read so the engineer enters the values by hand', async () => {
    const failed = job({
      status: 'failed',
      stage: 'failed',
      round: 0,
      info: { ...base, message: 'The AI drawing reader is not available. Enter the values by hand.' },
    });
    vi.spyOn(api, 'get').mockResolvedValue(failed);
    const onDone = vi.fn();
    render(<AiReadPanel jobId="j1" onDone={onDone} onLost={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(failed.info, false));
    expect(screen.getByText(/Could not finish: The AI drawing reader is not available/)).toBeInTheDocument();
  });

  it('shows no error when the read is gone (in-browser server restarted): it just goes away', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(
      new ApiError(404, 'No such AI read (it may have finished more than an hour ago).'),
    );
    const onLost = vi.fn();
    render(<AiReadPanel jobId="j1" onDone={vi.fn()} onLost={onLost} />);
    await waitFor(() => expect(onLost).toHaveBeenCalled());
    expect(screen.queryByText(/No such AI read/)).not.toBeInTheDocument();
  });

  it('keeps checking quietly through a passing hiccup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const replies: (AiJob | Error)[] = [new Error('Failed to fetch'), job({ stage: 'verify', round: 1 })];
    vi.spyOn(api, 'get').mockImplementation(async () => {
      const r = replies.shift() ?? job({ stage: 'verify', round: 1 });
      if (r instanceof Error) throw r;
      return r;
    });
    render(<AiReadPanel jobId="j1" onDone={vi.fn()} onLost={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText(/Checking every value against the drawing/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

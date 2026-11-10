import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

export interface ToolpathSegment {
  block: number;
  line: number;
  tool: number | null;
  kind: 'rapid' | 'feed';
  cycle: boolean;
  points: [number, number][]; // [z, r]
}

export interface Toolpath {
  segments: ToolpathSegment[];
  blocks: { index: number; line: number; text: string }[];
  warnings: { line: number | null; message: string }[];
  tools: number[];
  bounds: { z_min: number; z_max: number; r_min: number; r_max: number } | null;
  stock: { r: number; z_front: number; z_back: number } | null;
}

const TOOL_COLOURS = ['#1d4ed8', '#c2410c', '#15803d', '#7e22ce', '#b91c1c', '#0e7490', '#a16207', '#be185d'];
const toolColour = (tool: number | null): string =>
  tool === null ? '#6b7280' : TOOL_COLOURS[(tool - 1 + TOOL_COLOURS.length) % TOOL_COLOURS.length];

export default function ToolpathView({
  programId,
  selectedLine,
  onSelectLine,
}: {
  programId: number;
  selectedLine?: number | null;
  onSelectLine?: (line: number) => void;
}) {
  const [data, setData] = useState<Toolpath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bar, setBar] = useState('');
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    const qs = bar.trim() && Number(bar) > 0 ? `?bar_diameter=${Number(bar)}` : '';
    api
      .get<Toolpath>(`/programs/${programId}/toolpath${qs}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [programId, bar]);

  // Blocks that draw something, in order: the slider steps through these.
  const drawn = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.segments.map((s) => s.block))].sort((a, b) => a - b);
  }, [data]);

  // Follow a line selected in the program text.
  useEffect(() => {
    if (!data || selectedLine == null) return;
    const blk = data.blocks.find((b) => b.line === selectedLine);
    if (!blk) return;
    const idx = drawn.findIndex((b) => b >= blk.index);
    if (idx >= 0) setStep(idx);
  }, [selectedLine, data, drawn]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-sm text-gray-600">Drawing tool path…</p>;
  if (!data.bounds) return <p className="text-sm text-gray-600">Nothing to draw.</p>;

  const pos = step ?? drawn.length - 1;
  const current = drawn[pos];
  const curBlock = data.blocks.find((b) => b.index === current);

  // view box in (z, -r) space with padding; include the axis and the stock
  const b = data.bounds;
  const rMin = Math.min(b.r_min, 0);
  let zMin = b.z_min;
  let zMax = b.z_max;
  let rMax = b.r_max;
  if (data.stock) {
    zMin = Math.min(zMin, data.stock.z_back);
    zMax = Math.max(zMax, data.stock.z_front);
    rMax = Math.max(rMax, data.stock.r);
  }
  const pad = Math.max(zMax - zMin, rMax - rMin) * 0.06 + 1;
  const vb = `${zMin - pad} ${-rMax - pad} ${zMax - zMin + 2 * pad} ${rMax - rMin + 2 * pad}`;

  return (
    <section className="space-y-3 rounded border bg-white p-4" aria-label="Tool path">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-semibold">Tool path (simulation)</h2>
          <p className="text-xs text-gray-500">
            Z horizontal, X as radius vertical. Rapid = dashed, feed = solid. Programmed path only:
            nose-radius compensation and corner R are not shown. A visual aid, not proof the program is safe.
          </p>
        </div>
        <label className="text-sm">
          Bar Ø (mm){' '}
          <input
            className="input inline-block w-24"
            aria-label="Bar diameter"
            placeholder="manual"
            inputMode="decimal"
            value={bar}
            onChange={(e) => setBar(e.target.value)}
          />
        </label>
      </div>

      <svg
        viewBox={vb}
        className="h-80 w-full rounded border bg-gray-50"
        role="img"
        aria-label="Tool path drawing"
      >
        {/* spindle axis and part face */}
        <line
          x1={zMin - pad}
          x2={zMax + pad}
          y1={0}
          y2={0}
          stroke="#9ca3af"
          strokeDasharray="6 2 1 2"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={0}
          x2={0}
          y1={-rMax - pad}
          y2={-rMin + pad}
          stroke="#d1d5db"
          vectorEffect="non-scaling-stroke"
        />
        {data.stock && (
          <rect
            data-testid="stock"
            x={data.stock.z_back}
            y={-data.stock.r}
            width={data.stock.z_front - data.stock.z_back}
            height={data.stock.r}
            fill="#e5e7eb"
            fillOpacity={0.6}
            stroke="#6b7280"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {data.segments.map((s, k) => {
          const future = current !== undefined && s.block > current;
          const isCurrent = s.block === current;
          return (
            <polyline
              key={k}
              data-kind={s.kind}
              points={s.points.map(([z, r]) => `${z},${-r}`).join(' ')}
              fill="none"
              stroke={future ? '#d1d5db' : toolColour(s.tool)}
              strokeOpacity={future ? 0.5 : 1}
              strokeWidth={isCurrent ? 3 : s.kind === 'feed' ? 1.5 : 1}
              strokeDasharray={s.kind === 'rapid' ? '4 3' : undefined}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setStep(drawn.indexOf(s.block));
                onSelectLine?.(s.line);
              }}
            />
          );
        })}
      </svg>

      <div className="space-y-1">
        <input
          type="range"
          className="w-full"
          aria-label="Block slider"
          min={0}
          max={Math.max(drawn.length - 1, 0)}
          value={pos}
          onChange={(e) => {
            const v = Number(e.target.value);
            setStep(v);
            const blk = data.blocks.find((x) => x.index === drawn[v]);
            if (blk) onSelectLine?.(blk.line);
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            Block {pos + 1} / {drawn.length}
            {curBlock && (
              <>
                {' '}
                · line {curBlock.line}:{' '}
                <code className="rounded bg-blue-100 px-1" data-testid="current-block">
                  {curBlock.text}
                </code>
              </>
            )}
          </span>
          <span className="flex flex-wrap gap-2 text-xs">
            {data.tools.map((t) => (
              <span key={t} className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-4 rounded" style={{ background: toolColour(t) }} />T
                {String(t).padStart(2, '0')}
              </span>
            ))}
          </span>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <ul className="list-inside list-disc text-xs text-amber-800">
          {data.warnings.map((w, k) => (
            <li key={k}>
              {w.line ? `line ${w.line}: ` : ''}
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Zoomed tiles of a drawing PDF for the AI agents (hosted build: the in-browser server asks the
 * page for them). Same layout as the server's drawing_images.py: per page the whole sheet plus
 * overlapping 2x2 tiles (3x2 for A2 and larger) at the model's full resolution, so stacked
 * tolerances and small text are read, not guessed. Also the numbers in the PDF's text layer.
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_EDGE = 2576;
const MAX_PAGES = 3;
const OVERLAP = 0.08;
const MAX_B64 = 1_600_000; // bigger PNGs are noisy scans: JPEG keeps them small

export interface TileImage {
  label: string;
  described: string;
  media: string;
  data: string; // base64, no data: prefix
}

export function gridFor(w: number, h: number): [number, number] {
  const big = Math.max(w, h) > 1700; // points: A3 is 1191, A2 is 1684
  if (w >= h) return big ? [3, 2] : [2, 2];
  return big ? [2, 3] : [2, 2];
}

export function tileBoxes(w: number, h: number, cols: number, rows: number) {
  const tw = w / cols;
  const th = h / rows;
  const out: [number, number, number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push([
        Math.max(0, Math.round(c * tw - tw * OVERLAP)),
        Math.max(0, Math.round(r * th - th * OVERLAP)),
        Math.min(w, Math.round((c + 1) * tw + tw * OVERLAP)),
        Math.min(h, Math.round((r + 1) * th + th * OVERLAP)),
      ]);
  return out;
}

const POS: Record<string, string[]> = {
  '2x2': ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  '3x2': ['top-left', 'top-middle', 'top-right', 'bottom-left', 'bottom-middle', 'bottom-right'],
  '2x3': ['top-left', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-right'],
};

function encode(src: HTMLCanvasElement, box: [number, number, number, number]) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const s = Math.min(1, MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, w, h, 0, 0, c.width, c.height);
  let url = c.toDataURL('image/png');
  let media = 'image/png';
  if (url.length > MAX_B64) {
    url = c.toDataURL('image/jpeg', 0.85);
    media = 'image/jpeg';
  }
  const size = `${c.width}x${c.height}`;
  c.width = c.height = 0;
  return { media, data: url.slice(url.indexOf(',') + 1), size };
}

export async function renderTiles(pdf: ArrayBuffer): Promise<{ images: TileImage[]; numbers: string[] }> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
  const images: TileImage[] = [];
  const numbers = new Set<string>();
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const [cols, rows] = gridFor(base.width, base.height);
    const scale = Math.min((MAX_EDGE * Math.max(cols, rows)) / Math.max(base.width, base.height), 12);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const label = `Page ${i} of ${doc.numPages}`;
    const whole = encode(canvas, [0, 0, canvas.width, canvas.height]);
    images.push({
      label: `${label}: whole sheet.`,
      described: `${label} whole sheet ${whole.size}`,
      ...whole,
    });
    const names = POS[`${cols}x${rows}`] ?? [];
    tileBoxes(canvas.width, canvas.height, cols, rows).forEach((box, k) => {
      const name = names[k] ?? `tile ${k + 1}`;
      const t = encode(canvas, box);
      images.push({
        label: `${label}: zoomed tile, ${name} of the sheet (overlaps its neighbours).`,
        described: `${label} tile ${name} ${t.size}`,
        ...t,
      });
    });
    canvas.width = canvas.height = 0;
    const text = await page.getTextContent();
    for (const it of text.items) {
      const str = 'str' in it ? it.str : '';
      for (const m of str.matchAll(/(?<![\w.])\d+(?:[.,]\d+)?/g)) numbers.add(m[0].replace(',', '.'));
    }
  }
  await doc.destroy();
  return { images, numbers: [...numbers].slice(0, 400) };
}

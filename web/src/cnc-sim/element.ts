/**
 * <cnc-simulator>: lathe machining animation as a Web Component (Shadow DOM, three.js).
 *   <cnc-simulator program-url="/samples/O0003.nc" speed="10" autoplay></cnc-simulator>
 *   el.loadProgram(text); el.play(); el.pause(); el.seek(s); el.jumpToEnd(); el.setSpeed(x)
 *   events: progress, line, operation, finished, warning
 */
import { SIM_CONFIG } from './config';
import { Grid, cutMove } from './grid';
import { F, STRIDE, moveAt, type JobMode } from './job';
import type { Precomputed } from './precompute';
import { Runner } from './runner';
import { CncScene, type Look, type Theme } from './scene';

const SPEEDS: (number | 'max')[] = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 'max'];

const CSS = `
:host{display:block;width:100%;height:100%;min-height:520px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
 --sim-bg:#0f1b2d;--sim-panel:#13233a;--sim-border:#24364f;--sim-text:#e2e8f0;--sim-muted:#94a3b8;--sim-accent:#3b82f6;
 --sim-viewport:#eef2f6;--sim-stock:#7cc0f0;--sim-fresh:#facc15;--sim-cap:#3b82c4;--sim-rapid:#f97316;--sim-ghost:#c084fc;
 --sim-fixture:#9aa5b1;--sim-holder:#b0663a;--sim-insert:#111827;--sim-line:#1d4ed8}
@media (prefers-color-scheme:dark){:host{--sim-viewport:#d9e0e8}}
*{box-sizing:border-box}
.root{display:flex;flex-direction:column;height:100%;min-height:520px;background:var(--sim-bg);color:var(--sim-text);border-radius:12px;overflow:hidden}
.main{flex:1;display:flex;min-height:0}
.view{position:relative;flex:1;min-width:0;margin:8px;border-radius:10px;overflow:hidden;background:var(--sim-viewport)}
.canvas{position:absolute;inset:0}
.hud{position:absolute;left:10px;top:10px;background:rgba(15,23,42,.78);color:#e2e8f0;font:12px/1.45 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;pointer-events:none;min-width:210px;white-space:pre}
.hud b{color:#93c5fd;font-weight:600}
.scale{position:absolute;right:12px;bottom:12px;font:11px ui-monospace,monospace;color:#0f172a;text-align:center;pointer-events:none}
.scale i{display:block;height:6px;border:2px solid #0f172a;border-top:none;margin-top:2px}
.note{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(15,23,42,.85);color:#fde68a;font-size:12px;padding:5px 10px;border-radius:6px;display:flex;gap:8px;align-items:center;max-width:70%}
.note select{font-size:12px}
.fps{position:absolute;right:110px;top:10px;font:11px monospace;background:#0f172acc;color:#86efac;padding:2px 6px;border-radius:4px;display:none}
.loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#334155;font-size:14px}
.side{width:340px;display:flex;flex-direction:column;margin:8px 8px 8px 0;gap:8px;min-height:0}
.box{background:var(--sim-panel);border:1px solid var(--sim-border);border-radius:10px;display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--sim-border)}
.tabs button{flex:1;background:none;border:0;color:var(--sim-muted);padding:8px;font-size:12px;cursor:pointer}
.tabs button.on{color:var(--sim-text);box-shadow:inset 0 -2px var(--sim-accent)}
.code{flex:1;overflow:auto;font:12px/18px ui-monospace,Consolas,monospace;position:relative;min-height:120px}
.row{position:absolute;left:0;right:0;height:18px;display:flex;gap:8px;padding:0 8px;cursor:pointer;white-space:pre}
.row:hover{background:#1e3a5f}
.row.on{background:var(--sim-line);color:#fff}
.row .n{color:#64748b;width:30px;text-align:right;flex:none}
.row.on .n{color:#bfdbfe}
.seq{max-height:42%;overflow:auto}
.seqh{font-size:11px;letter-spacing:.06em;color:var(--sim-muted);padding:8px 10px;border-bottom:1px solid var(--sim-border)}
.op{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:pointer;position:relative}
.op:hover{background:#1e3a5f}.op.on{background:#1d3557}
.op .dot{width:9px;height:9px;border-radius:50%;flex:none}.op .t{margin-left:auto;color:var(--sim-muted);font-variant-numeric:tabular-nums}
.op .tn{color:var(--sim-muted)}
.op .bar{position:absolute;left:0;bottom:0;height:2px;background:var(--sim-accent)}
.setup{font-size:10px;color:var(--sim-muted);padding:6px 10px 2px;letter-spacing:.05em}
.transport{padding:6px 12px 10px;display:flex;flex-direction:column;gap:8px}
.tlwrap{position:relative;height:18px;cursor:pointer}
.tl{position:absolute;inset:4px 0;border-radius:5px;overflow:hidden;display:flex}
.tl span{height:100%;opacity:.85}
.tick{position:absolute;top:2px;width:2px;height:14px;background:#facc15;border-radius:1px;pointer-events:none}
.head{position:absolute;top:-1px;width:4px;height:20px;margin-left:-2px;background:#fff;border-radius:2px;box-shadow:0 0 0 2px var(--sim-accent);pointer-events:none}
.ctrls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
button.b{background:#1e2f47;border:1px solid var(--sim-border);color:var(--sim-text);border-radius:7px;padding:6px 10px;cursor:pointer;font-size:12px}
button.b:hover{background:#26405f}
button.primary{background:var(--sim-accent);border-color:var(--sim-accent);color:#fff;font-weight:600;min-width:86px}
select{background:#1e2f47;color:var(--sim-text);border:1px solid var(--sim-border);border-radius:7px;padding:5px}
label.t{display:flex;align-items:center;gap:4px;color:var(--sim-muted);cursor:pointer}
.time{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--sim-text)}
.legend{color:var(--sim-muted);font-size:11px}
.seg{display:inline-flex;border:1px solid var(--sim-border);border-radius:7px;overflow:hidden}
.seg button{background:none;border:0;color:var(--sim-muted);padding:5px 8px;cursor:pointer;font-size:12px}
.seg button.on{background:var(--sim-accent);color:#fff}
@media (max-width:900px){.main{flex-direction:column}.side{width:auto;margin:0 8px 8px}.view{min-height:340px}}
`;

const HTML = `
<div class="root">
 <div class="main">
  <div class="view">
   <div class="canvas"></div>
   <div class="loading">Loading program…</div>
   <div class="hud"></div>
   <div class="fps"></div>
   <div class="scale"><span></span><i></i></div>
   <div class="note" hidden></div>
  </div>
  <div class="side">
   <div class="box" style="flex:1">
    <div class="tabs"><button class="on" data-tab="text">Program text</button><button data-tab="moves">Move table</button></div>
    <div class="code"><div class="spacer"></div></div>
   </div>
   <div class="box seq"><div class="seqh"></div><div class="ops"></div></div>
  </div>
 </div>
 <div class="transport">
  <div class="tlwrap"><div class="tl"></div><div class="ticks"></div><div class="head"></div></div>
  <div class="ctrls">
   <button class="b" data-act="restart" title="Restart">⏮</button>
   <button class="b primary" data-act="play">▶ Play</button>
   <button class="b" data-act="end" title="Jump to end">⏭</button>
   <label class="t">Speed <select class="speed"></select></label>
   <label class="t"><input type="checkbox" class="realtime"> Real time</label>
   <label class="t"><input type="checkbox" class="loop"> Loop</label>
   <label class="t"><input type="checkbox" class="single"> Single block</label>
   <label class="t"><input type="checkbox" class="optstop"> M01 stop</label>
   <label class="t"><input type="checkbox" class="cutaway" checked> Cut-away</label>
   <label class="t"><input type="checkbox" class="paths" checked> Path</label>
   <label class="t extras-l" hidden><input type="checkbox" class="extras"> N33/N34</label>
   <span class="seg look"><button data-look="real" class="on">Realistic</button><button data-look="video">Video style</button><button data-look="enhanced">Enhanced</button></span>
   <span class="seg views"><button data-view="iso">Iso</button><button data-view="front">Front</button><button data-view="top">Top</button><button data-view="follow">Follow tool</button></span>
   <span class="time"></span>
  </div>
  <div class="legend">Realistic: steel stock, fresh cuts glint gold. Video style: blue = stock, yellow = freshly cut. Dotted orange = rapid moves. Drag to orbit, right-drag to pan, wheel to zoom, Space = play/pause, F = fps.</div>
 </div>
</div>`;

const fmt = (s0: number) => {
  const s = Number.isFinite(s0) ? Math.max(0, s0) : 0;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export class CncSimulator extends HTMLElement {
  static get observedAttributes() {
    return ['program-url', 'speed'];
  }

  private root: ShadowRoot;
  private $ = <T extends Element = HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private scene: CncScene | null = null;
  private runner: Runner | null = null;
  private data: Precomputed | null = null;
  private text = '';
  private grid: Grid | null = null;
  private t = 0;
  private playing = false;
  private speed: number | 'max' = SIM_CONFIG.defaultSpeed;
  private applied = { move: 0, frac: 0 };
  private raf = 0;
  private last = 0;
  private lastHud = 0;
  private lastMesh = 0;
  private meshVersion = -1;
  private lastCutT = -1e9;
  private dirty = true;
  private visible = true;
  private curLine = -1;
  private curOp = -1;
  private shownTool = -1;
  private toolAnim = 1;
  private flipAnim = 1;
  private spinAngle = 0;
  private fpsOn = false;
  private fpsFrames = 0;
  private fpsT = 0;
  private tab: 'text' | 'moves' = 'text';
  private mode: JobMode = 'full';
  private cleanups: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private dragging = false;
  private removedNow = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${CSS}</style>${HTML}`;
  }

  // ------------------------------------------------------------------ lifecycle

  connectedCallback() {
    if (this.scene) return;
    this.tabIndex = 0;
    const theme = this.readTheme();
    try {
      this.scene = new CncScene(this.$('.canvas'), theme);
    } catch {
      this.$('.loading').textContent = 'This browser has no WebGL: the 3D view cannot be shown.';
      return;
    }
    this.scene.setLook('real');
    this.runner = new Runner();
    this.grid = new Grid();
    const sp = this.$<HTMLSelectElement>('.speed');
    sp.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s === 'max' ? 'Max' : `${s}×`}</option>`).join(
      '',
    );
    const attrSpeed = Number(this.getAttribute('speed'));
    if (attrSpeed > 0) this.speed = attrSpeed;
    sp.value = String(this.speed);
    this.wire();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.$('.view'));
    this.io = new IntersectionObserver((e) => {
      this.visible = e[0]?.isIntersecting ?? true;
      this.kick();
    });
    this.io.observe(this);
    const vis = () => this.kick();
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
    this.resize();
    const url = this.getAttribute('program-url');
    if (url) void this.fetchProgram(url);
    this.kick();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.io?.disconnect();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.runner?.dispose();
    this.scene?.dispose();
    this.scene = null;
    this.runner = null;
    this.data = null;
    this.grid = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (!this.scene) return;
    if (name === 'program-url' && value) void this.fetchProgram(value);
    if (name === 'speed' && Number(value) > 0) this.setSpeed(Number(value));
  }

  private readTheme(): Theme {
    const cs = getComputedStyle(this);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    return {
      viewport: v('--sim-viewport', '#eef2f6'),
      stock: v('--sim-stock', '#7cc0f0'),
      fresh: v('--sim-fresh', '#facc15'),
      cap: v('--sim-cap', '#3b82c4'),
      rapid: v('--sim-rapid', '#f97316'),
      ghost: v('--sim-ghost', '#c084fc'),
      fixture: v('--sim-fixture', '#9aa5b1'),
      holder: v('--sim-holder', '#b0663a'),
      insert: v('--sim-insert', '#111827'),
    };
  }

  // ------------------------------------------------------------------ public API

  async loadProgram(text: string) {
    this.text = text;
    await this.compute();
  }

  play() {
    if (!this.data) return;
    if (this.t >= this.data.job.duration - 1e-6) this.seek(0);
    this.playing = true;
    this.updatePlayButton();
    this.kick();
  }

  pause() {
    this.playing = false;
    this.updatePlayButton();
    this.dirty = true;
  }

  seek(seconds: number) {
    if (!this.data || !this.grid) return;
    const job = this.data.job;
    const t = Math.max(0, Math.min(seconds, job.duration));
    const i = Math.max(0, moveAt(job.moves, job.count, t));
    const f = this.fracAt(i, t);
    // restore the latest snapshot at or before the target, then cut forward
    let snap = this.data.snaps[0];
    for (const s of this.data.snaps) if (s.move <= i) snap = s;
    if (t >= job.duration - 1e-9) {
      this.grid.restore(this.data.final);
      this.applied = { move: job.count - 1, frac: 1 };
    } else {
      this.grid.restore(snap.state);
      for (let k = snap.move; k < i; k++) cutMove(this.grid, job, k);
      if (f > 0) cutMove(this.grid, job, i, 0, f);
      this.applied = { move: i, frac: f };
    }
    this.t = t;
    this.toolAnim = 1;
    this.flipAnim = 1;
    this.scene?.flip(1);
    this.dirty = true;
    this.meshVersion = -1;
    this.kick();
  }

  jumpToEnd() {
    if (!this.data) return;
    this.seek(this.data.job.duration);
    this.pause();
  }

  setSpeed(x: number | 'max') {
    this.speed = x;
    this.$<HTMLSelectElement>('.speed').value = String(x);
  }

  // ------------------------------------------------------------------ loading

  private async fetchProgram(url: string) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      await this.loadProgram(await r.text());
    } catch (e) {
      this.$('.loading').textContent = `Could not load ${url}: ${(e as Error).message}`;
    }
  }

  private async compute() {
    if (!this.runner || !this.scene) return;
    this.pause();
    this.$('.loading').style.display = 'flex';
    const extras = this.$<HTMLInputElement>('.extras').checked;
    const data = await this.runner.run(this.text, { mode: this.mode, extras });
    if (!this.scene) return;
    this.data = data;
    this.$('.loading').style.display = 'none';
    this.scene.setJob(data.job);
    this.curLine = this.curOp = -1;
    this.shownTool = -1;
    this.renderSide();
    this.renderTimeline();
    this.renderNote();
    this.seek(0);
    for (const w of data.job.warnings)
      this.dispatchEvent(new CustomEvent('warning', { detail: { message: w } }));
    if (this.hasAttribute('autoplay')) this.play();
  }

  // ------------------------------------------------------------------ UI

  private wire() {
    const on = (sel: string, ev: string, fn: (e: Event) => void) => {
      const el = this.$(sel);
      el.addEventListener(ev, fn);
      this.cleanups.push(() => el.removeEventListener(ev, fn));
    };
    on('[data-act="play"]', 'click', () => (this.playing ? this.pause() : this.play()));
    on('[data-act="restart"]', 'click', () => {
      this.seek(0);
      this.kick();
    });
    on('[data-act="end"]', 'click', () => this.jumpToEnd());
    on('.speed', 'change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.speed = v === 'max' ? 'max' : Number(v);
    });
    on('.cutaway', 'change', (e) => {
      this.scene?.setCutaway((e.target as HTMLInputElement).checked);
      this.meshVersion = -1;
      this.dirty = true;
      this.kick();
    });
    on('.paths', 'change', (e) => {
      this.scene?.setPathsVisible((e.target as HTMLInputElement).checked);
      this.dirty = true;
      this.kick();
    });
    on('.extras', 'change', () => void this.compute());
    on('.look', 'click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      for (const x of this.root.querySelectorAll('.look button')) x.classList.toggle('on', x === b);
      this.scene?.setLook(b.dataset.look as Look);
      this.meshVersion = -1;
      this.dirty = true;
      this.kick();
    });
    on('.views', 'click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      for (const x of this.root.querySelectorAll('.views button')) x.classList.toggle('on', x === b);
      this.scene?.setView(b.dataset.view as 'iso' | 'front' | 'top' | 'follow');
      this.kick();
    });
    on('.tabs', 'click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      this.tab = b.dataset.tab as 'text' | 'moves';
      for (const x of this.root.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
      this.renderSide();
    });
    on('.code', 'scroll', () => this.renderRows());
    on('.code', 'click', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
      if (!row || !this.data) return;
      const job = this.data.job;
      if (this.tab === 'moves') {
        const i = Number(row.dataset.i);
        this.seek(job.moves[i * STRIDE + F.t0] + 1e-6);
      } else {
        const line = Number(row.dataset.i) + 1;
        for (let i = 0; i < job.count; i++)
          if (job.moves[i * STRIDE + F.line] >= line) {
            this.seek(job.moves[i * STRIDE + F.t0] + 1e-6);
            break;
          }
      }
    });
    on('.ops', 'click', (e) => {
      const r = (e.target as HTMLElement).closest('.op') as HTMLElement | null;
      if (!r || !this.data) return;
      this.seek(this.data.job.ops[Number(r.dataset.i)].t0 + 1e-6);
    });
    const tl = this.$('.tlwrap');
    const scrub = (e: PointerEvent) => {
      if (!this.data) return;
      const rect = tl.getBoundingClientRect();
      this.seek(((e.clientX - rect.left) / rect.width) * this.data.job.duration);
    };
    on('.tlwrap', 'pointerdown', (e) => {
      this.dragging = true;
      tl.setPointerCapture((e as PointerEvent).pointerId);
      scrub(e as PointerEvent);
    });
    on('.tlwrap', 'pointermove', (e) => this.dragging && scrub(e as PointerEvent));
    on('.tlwrap', 'pointerup', () => (this.dragging = false));
    on('.canvas', 'pointerdown', (e) => {
      const pe = e as PointerEvent;
      const rect = this.$('.canvas').getBoundingClientRect();
      if (this.scene?.cubeClick(pe.clientX - rect.left, pe.clientY - rect.top)) {
        e.stopPropagation();
        this.kick();
      }
    });
    on('.canvas', 'pointermove', () => this.kick());
    on('.canvas', 'wheel', () => this.kick());
    const key = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        this.fpsOn = !this.fpsOn;
        this.$('.fps').style.display = this.fpsOn ? 'block' : 'none';
      } else if (e.key === ' ') {
        e.preventDefault();
        if (this.playing) this.pause();
        else this.play();
      }
    };
    this.addEventListener('keydown', key);
    this.cleanups.push(() => this.removeEventListener('keydown', key));
  }

  private updatePlayButton() {
    this.$('[data-act="play"]').textContent = this.playing ? '⏸ Pause' : '▶ Play';
  }

  private renderNote() {
    const note = this.$('.note');
    const job = this.data?.job;
    this.$('.extras-l').hidden = !job?.hasExtras;
    if (!job || job.m99Target === null) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    note.innerHTML = `M99 P${job.m99Target} at the top: the machine jumps to N${job.m99Target}.
      <select class="mode"><option value="full">Full job</option><option value="machine">Machine-accurate (start at N${job.m99Target})</option></select>`;
    const sel = note.querySelector('select') as HTMLSelectElement;
    sel.value = this.mode;
    sel.onchange = () => {
      this.mode = sel.value as JobMode;
      void this.compute();
    };
  }

  private renderTimeline() {
    const job = this.data!.job;
    const d = job.duration || 1;
    this.$('.tl').innerHTML = job.ops
      .map((o) => `<span style="width:${((o.t1 - o.t0) / d) * 100}%;background:${o.colour}"></span>`)
      .join('');
    this.$('.ticks').innerHTML = job.toolChanges
      .map((t) => `<i class="tick" style="left:${(t / d) * 100}%"></i>`)
      .join('');
  }

  private renderSide() {
    const job = this.data?.job;
    if (!job) return;
    const ops = job.ops;
    this.$('.seqh').textContent = `SEQUENCE · ${ops.length} OPERATIONS · ${fmt(job.duration)} ESTIMATE`;
    let html = '';
    let lastSetup = -1;
    for (const o of ops) {
      if (o.setup !== lastSetup) {
        lastSetup = o.setup;
        html += `<div class="setup">${job.setups[o.setup].name}</div>`;
      }
      const tool = o.tool ? `T${String(o.tool).padStart(2, '0')}` : '';
      html += `<div class="op" data-i="${o.index}"><span class="dot" style="background:${o.colour}"></span>${o.name}
        <span class="tn">${tool}</span><span class="t">${fmt(o.t1 - o.t0)}</span><span class="bar" style="width:0"></span></div>`;
    }
    this.$('.ops').innerHTML = html;
    const n = this.tab === 'text' ? this.data!.job.lines.length : job.count;
    (this.$('.spacer') as HTMLElement).style.height = `${n * 18}px`;
    this.renderRows();
  }

  /** Virtualised rows: only the visible ones exist. */
  private renderRows() {
    const job = this.data?.job;
    if (!job) return;
    const box = this.$('.code');
    const n = this.tab === 'text' ? job.lines.length : job.count;
    const first = Math.max(0, Math.floor(box.scrollTop / 18) - 5);
    const last = Math.min(n, first + Math.ceil(box.clientHeight / 18) + 10);
    for (const r of [...box.querySelectorAll('.row')]) r.remove();
    const frag = document.createDocumentFragment();
    const cur = job.moves[Math.max(0, this.applied.move) * STRIDE + F.line];
    for (let i = first; i < last; i++) {
      const d = document.createElement('div');
      d.className = 'row';
      d.dataset.i = String(i);
      d.style.top = `${i * 18}px`;
      if (this.tab === 'text') {
        if (i + 1 === cur) d.classList.add('on');
        d.innerHTML = `<span class="n">${i + 1}</span><span></span>`;
        (d.lastChild as HTMLElement).textContent = job.lines[i];
      } else {
        const o = i * STRIDE;
        const m = job.moves;
        if (i === this.applied.move) d.classList.add('on');
        const type = ['G0', 'G1', 'G32', 'G4', 'T'][m[o + F.type]];
        d.innerHTML = `<span class="n">${m[o + F.line]}</span><span>${type.padEnd(3)} X${m[o + F.x1].toFixed(3).padStart(8)} Z${m[o + F.z1].toFixed(3).padStart(8)} ${fmt(m[o + F.t0])}</span>`;
      }
      frag.appendChild(d);
    }
    box.appendChild(frag);
  }

  private scrollToRow(i: number) {
    const box = this.$('.code');
    const y = i * 18;
    if (y < box.scrollTop + 18 || y > box.scrollTop + box.clientHeight - 36)
      box.scrollTop = Math.max(0, y - box.clientHeight / 3);
    this.renderRows();
  }

  private resize() {
    const v = this.$('.canvas');
    this.scene?.resize(v.clientWidth, v.clientHeight);
    this.dirty = true;
    this.kick();
  }

  // ------------------------------------------------------------------ playback loop

  private kick() {
    if (this.raf || !this.scene) return;
    if (document.hidden || !this.visible) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private fracAt(i: number, t: number) {
    const o = i * STRIDE;
    const m = this.data!.job.moves;
    const span = m[o + F.t1] - m[o + F.t0];
    return span > 0 ? Math.min(1, Math.max(0, (t - m[o + F.t0]) / span)) : 1;
  }

  private loop = (now: number) => {
    this.raf = 0;
    const scene = this.scene;
    const data = this.data;
    const grid = this.grid;
    if (!scene || document.hidden || !this.visible) return;
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    let busy = this.playing;

    if (data && grid) {
      const job = data.job;
      if (this.playing) {
        const realtime = this.$<HTMLInputElement>('.realtime').checked;
        const sp = realtime
          ? 1
          : this.speed === 'max'
            ? job.duration / SIM_CONFIG.maxSpeedSeconds
            : this.speed;
        let target = this.t + dt * sp;
        // single block / optional stop
        const iNow = Math.max(0, moveAt(job.moves, job.count, this.t));
        if (this.$<HTMLInputElement>('.single').checked) {
          const line = job.moves[iNow * STRIDE + F.line];
          for (let k = iNow + 1; k < job.count; k++)
            if (job.moves[k * STRIDE + F.line] !== line) {
              const b = job.moves[k * STRIDE + F.t0];
              if (target >= b) {
                target = b;
                this.playing = false;
              }
              break;
            }
        }
        if (this.$<HTMLInputElement>('.optstop').checked)
          for (const s of job.optionalStops)
            if (s > this.t + 1e-6 && s <= target) {
              target = s;
              this.playing = false;
              break;
            }
        if (target >= job.duration) {
          if (this.$<HTMLInputElement>('.loop').checked) {
            this.seek(0);
            target = 0;
          } else {
            target = job.duration;
            this.playing = false;
            this.dispatchEvent(new CustomEvent('finished'));
          }
        }
        if (!this.playing) this.updatePlayButton();
        this.advanceTo(target);
      }
      // what is running now
      const i = Math.max(0, moveAt(job.moves, job.count, this.t));
      const o = i * STRIDE;
      const m = job.moves;
      const f = this.fracAt(i, this.t);
      const z = m[o + F.z0] + (m[o + F.z1] - m[o + F.z0]) * f;
      const x = m[o + F.x0] + (m[o + F.x1] - m[o + F.x0]) * f;
      const setup = m[o + F.setup];
      if (scene.showSetup(setup, grid, this.playing)) this.flipAnim = 0;
      if (this.flipAnim < 1) {
        this.flipAnim = Math.min(1, this.flipAnim + dt / SIM_CONFIG.flipAnim);
        scene.flip(this.flipAnim);
        busy = true;
      }
      const tool = m[o + F.tool];
      if (tool !== this.shownTool) {
        if (this.shownTool !== -1 && this.playing) this.toolAnim = 0;
        this.shownTool = tool;
      }
      let retract = 0;
      if (this.toolAnim < 1) {
        this.toolAnim = Math.min(1, this.toolAnim + dt / SIM_CONFIG.toolChangeAnim);
        retract = 60 * Math.sin(Math.PI * this.toolAnim);
        busy = true;
      }
      const op = job.ops[m[o + F.op]];
      scene.placeTool(tool, op.name, z, x, retract);
      scene.showProgress(i, f, z, x);
      // spindle
      const rpm = m[o + F.rpm];
      if (this.playing && rpm) {
        const rps = Math.min(Math.abs(rpm) / 60, SIM_CONFIG.spinCap);
        this.spinAngle += (rpm > 0 ? -1 : 1) * rps * 2 * Math.PI * dt;
      }
      const cutting = this.removedNow > 0 && m[o + F.type] !== 0;
      if (scene.effects(dt, cutting, this.playing)) busy = true;
      if (!this.playing) this.removedNow = 0;
      const cutaway = this.$<HTMLInputElement>('.cutaway').checked;
      scene.spin(this.spinAngle, !cutaway);
      // part mesh at most meshHz, or while the yellow fade runs
      const fading = this.t - this.lastCutT < SIM_CONFIG.fadeSeconds + 0.5;
      if (
        (grid.version !== this.meshVersion || (fading && this.playing)) &&
        now - this.lastMesh > 1000 / SIM_CONFIG.meshHz
      ) {
        if (grid.version !== this.meshVersion) this.lastCutT = this.t;
        this.meshVersion = grid.version;
        this.lastMesh = now;
        scene.rebuildPart(grid, this.t);
        this.dirty = true;
      }
      if (grid.version !== this.meshVersion) busy = true;
      // text at most 15 Hz
      if (now - this.lastHud > 66 || !this.playing) {
        this.lastHud = now;
        this.updateHud(i, z, x, op.index);
      }
    }
    if (scene.updateCamera(dt)) busy = true;
    if (busy || this.dirty) {
      scene.render();
      this.dirty = false;
    }
    if (this.fpsOn) {
      this.fpsFrames++;
      if (now - this.fpsT > 500) {
        this.$('.fps').textContent = `${Math.round((this.fpsFrames * 1000) / (now - this.fpsT))} fps`;
        this.fpsFrames = 0;
        this.fpsT = now;
      }
      busy = true;
    }
    // keep looping while playing/animating/damping; otherwise sleep until the next event
    if (busy) this.raf = requestAnimationFrame(this.loop);
  };

  /** Cut forward from the applied state to time t (jumps through snapshots when far behind). */
  private advanceTo(t: number) {
    const data = this.data!;
    const job = data.job;
    const grid = this.grid!;
    const i = Math.max(0, moveAt(job.moves, job.count, t));
    const f = this.fracAt(i, t);
    this.removedNow = 0;
    let { move, frac } = this.applied;
    // far ahead: restore the latest snapshot in between instead of cutting every move
    let snap: Precomputed['snaps'][number] | null = null;
    for (const s of data.snaps) if (s.move > move && s.move <= i) snap = s;
    if (snap && i - snap.move < i - move) {
      grid.restore(snap.state);
      move = snap.move;
      frac = 0;
    }
    while (move <= i) {
      const end = move === i ? f : 1;
      if (end > frac) this.removedNow += cutMove(grid, job, move, frac, end);
      if (move === i) {
        frac = Math.max(frac, end);
        break;
      }
      move++;
      frac = 0;
    }
    this.applied = { move, frac };
    this.t = t;
  }

  private updateHud(i: number, z: number, x: number, opIndex: number) {
    const job = this.data!.job;
    const o = i * STRIDE;
    const m = job.moves;
    const rpm = m[o + F.rpm];
    const feed = m[o + F.feedMin];
    const line = m[o + F.line];
    const tool = m[o + F.tool];
    const op = job.ops[opIndex];
    const setup = job.setups[m[o + F.setup]];
    this.$('.hud').innerHTML =
      `<b>${op.name}</b>  ·  ${setup.name}\n` +
      `X ${x.toFixed(3).padStart(9)}   Z ${z.toFixed(3).padStart(9)}\n` +
      `Feed ${feed >= 0 ? `${feed.toFixed(0)} mm/min` : '—'}   F ${m[o + F.feedRev] >= 0 ? m[o + F.feedRev].toFixed(2) : '—'}\n` +
      `Spindle ${rpm ? `${Math.abs(rpm).toFixed(0)} rpm ${rpm > 0 ? 'CW' : 'CCW'}` : 'off'}\n` +
      `Tool T${String(tool).padStart(2, '0')}   Line ${line}\n` +
      `Time ${fmt(this.t)} / ${fmt(job.duration)} estimate`;
    this.$('.time').textContent = `${fmt(this.t)} / ${fmt(job.duration)} estimate`;
    const d = job.duration || 1;
    this.$('.head').style.left = `${(this.t / d) * 100}%`;
    // scale bar
    const mmpp = this.scene!.mmPerPixel();
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((v) => v / mmpp >= 60) ?? 200;
    this.$('.scale span').textContent = `${nice} mm`;
    (this.$('.scale i') as HTMLElement).style.width = `${nice / mmpp}px`;
    // sequence
    if (opIndex !== this.curOp) {
      this.curOp = opIndex;
      for (const r of this.root.querySelectorAll('.op'))
        r.classList.toggle('on', Number((r as HTMLElement).dataset.i) === opIndex);
      this.dispatchEvent(new CustomEvent('operation', { detail: { index: opIndex, name: op.name, tool } }));
    }
    const bar = this.root.querySelector(`.op[data-i="${opIndex}"] .bar`) as HTMLElement | null;
    if (bar) bar.style.width = `${Math.min(100, ((this.t - op.t0) / Math.max(1e-6, op.t1 - op.t0)) * 100)}%`;
    if (line !== this.curLine) {
      this.curLine = line;
      this.scrollToRow(this.tab === 'text' ? line - 1 : i);
      this.dispatchEvent(new CustomEvent('line', { detail: { line, text: job.lines[line - 1] } }));
    }
    this.dispatchEvent(
      new CustomEvent('progress', { detail: { time: this.t, duration: job.duration, line } }),
    );
  }
}

export function defineCncSimulator() {
  if (!customElements.get('cnc-simulator')) customElements.define('cnc-simulator', CncSimulator);
}

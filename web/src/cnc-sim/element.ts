/**
 * <cnc-simulator>: lathe machining animation as a Web Component (Shadow DOM, three.js).
 *   <cnc-simulator program-url="/samples/O0003.nc" speed="10" autoplay></cnc-simulator>
 *   el.loadProgram(text); el.play(); el.pause(); el.seek(s); el.jumpToEnd(); el.setSpeed(x)
 *   el.setStock({ diameter, length })  // the part's bar (also bar-diameter / part-length attributes)
 *   events: progress, line, operation, finished, warning, checks
 */
import { SIM_CONFIG } from './config';
import { Grid, cutMove } from './grid';
import { F, STRIDE, moveAt, type JobMode, type JobOptions, type SimCheck } from './job';
import { applyStock, type Precomputed } from './precompute';
import { Runner } from './runner';
import { CncScene, type Look, type Quality, type Theme } from './scene';

const SPEEDS: (number | 'max')[] = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 'max'];

const ICON = {
  restart: '<svg viewBox="0 0 24 24"><path d="M6 5v14M19 6l-9 6 9 6V6z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7V5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM14 5h3v14h-3z" fill="currentColor"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  end: '<svg viewBox="0 0 24 24"><path d="M18 5v14M5 6l9 6-9 6V6z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  spindle:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/></svg>',
};

const CSS = `
:host{display:block;width:100%;height:100%;min-height:520px;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
 --sim-bg:#0b1320;--sim-panel:#111c2c;--sim-panel2:#16243a;--sim-border:#22344d;--sim-text:#e6edf5;--sim-muted:#8ea0b8;
 --sim-accent:#3b82f6;--sim-accent2:#22d3ee;--sim-ok:#22c55e;--sim-warn:#f59e0b;
 --sim-viewport:#e9eef3;--sim-stock:#7cc0f0;--sim-fresh:#facc15;--sim-cap:#3b82c4;--sim-rapid:#f97316;--sim-ghost:#c084fc;
 --sim-fixture:#9aa5b1;--sim-holder:#b0663a;--sim-insert:#111827;--sim-line:#1d4ed8}
*{box-sizing:border-box}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:host(:fullscreen){width:100vw;height:100vh;min-height:0}
:host(:fullscreen) .root{border-radius:0;height:100vh}
.root{display:flex;flex-direction:column;height:100%;min-height:520px;background:var(--sim-bg);color:var(--sim-text);border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(2,8,23,.35)}
.main{flex:1;display:flex;min-height:0}
.view{position:relative;flex:1;min-width:0;margin:10px;border-radius:12px;overflow:hidden;background:#12171e;box-shadow:inset 0 0 0 1px var(--sim-border)}
.canvas{position:absolute;inset:0}
.glass{background:rgba(10,16,26,.74);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(148,163,184,.18);border-radius:12px}
.dro{position:absolute;left:12px;top:12px;padding:10px 12px;min-width:250px;pointer-events:none;color:#e6edf5}
.dro .dhead{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:5px;font:600 10px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:4px 7px;border-radius:999px;background:rgba(59,130,246,.18);color:#bfdbfe;white-space:nowrap}
.chip.op{background:rgba(34,211,238,.16);color:#a5f3fc}
.chip.off{background:rgba(148,163,184,.14);color:#94a3b8}
.chip.on{background:rgba(34,197,94,.18);color:#86efac}
.chip.rapid{background:rgba(249,115,22,.2);color:#fdba74}
.axes{display:grid;grid-template-columns:auto 1fr;gap:0 12px;align-items:baseline;font-family:"JetBrains Mono",ui-monospace,Consolas,monospace}
.axes b{font-size:13px;color:#93c5fd;font-weight:700}
.axes span{font-size:24px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.meta{display:grid;grid-template-columns:repeat(2,auto);gap:4px 14px;margin-top:8px;font:12px/1.4 "JetBrains Mono",ui-monospace,monospace;color:#cbd5e1;align-items:center}
.meta i{font-style:normal;color:#64748b;margin-right:4px}
.spin{display:inline-flex;align-items:center;gap:5px}
.spin svg{width:14px;height:14px}
.spin.run svg{animation:sp .5s linear infinite}
.spin.ccw svg{animation-direction:reverse}
@keyframes sp{to{transform:rotate(360deg)}}
.vtools{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;align-items:flex-end}
.scale{padding:6px 10px;font:11px "JetBrains Mono",ui-monospace,monospace;color:#cbd5e1;text-align:center;pointer-events:none}
.scale i{display:block;height:6px;border:2px solid #cbd5e1;border-top:none;margin:3px auto 0}
.ibtn{display:inline-flex;align-items:center;gap:6px;color:#e6edf5;border:1px solid rgba(148,163,184,.25);background:rgba(10,16,26,.74);border-radius:10px;padding:7px 10px;font-size:12px;cursor:pointer}
.ibtn:hover{background:rgba(30,58,95,.85)}
.note{position:absolute;left:50%;top:12px;transform:translateX(-50%);color:#fde68a;font-size:12px;padding:6px 10px;display:flex;gap:8px;align-items:center;max-width:56%}
.note select{font-size:12px}
.alarms{position:absolute;left:12px;bottom:12px;max-width:min(46%,420px);max-height:42%;overflow:auto;padding:8px 10px;font-size:12px;color:#fecaca;border-color:rgba(239,68,68,.45)}
.alarms.ok{color:#bbf7d0;border-color:rgba(34,197,94,.4);padding:6px 10px}
.alarms h4{margin:0 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;display:flex;gap:6px;align-items:center}
.alarms button{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:4px 6px;border-radius:6px;cursor:pointer}
.alarms button:hover{background:rgba(239,68,68,.18)}
.alarms b{font:11px ui-monospace,monospace;color:#fca5a5;margin-right:6px}
.alarm{position:absolute;top:0;width:4px;height:22px;margin-left:-2px;background:#ef4444;border-radius:2px;box-shadow:0 0 0 2px rgba(239,68,68,.3);pointer-events:none}
.fps{position:absolute;right:116px;top:14px;font:11px monospace;padding:3px 7px;color:#86efac;display:none}
.loading{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;color:#cbd5e1;font-size:13px;background:#12171e}
.loading:before{content:"";width:34px;height:34px;border-radius:50%;border:3px solid rgba(148,163,184,.25);border-top-color:var(--sim-accent);animation:sp .8s linear infinite}
.side{width:340px;display:flex;flex-direction:column;margin:10px 10px 10px 0;gap:10px;min-height:0}
.box{background:var(--sim-panel);border:1px solid var(--sim-border);border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.tabs{display:flex;border-bottom:1px solid var(--sim-border);background:var(--sim-panel2)}
.tabs button{flex:1;background:none;border:0;color:var(--sim-muted);padding:9px;font-size:12px;font-weight:600;cursor:pointer}
.tabs button.on{color:var(--sim-text);box-shadow:inset 0 -2px var(--sim-accent)}
.code{flex:1;overflow:auto;font:12px/18px "JetBrains Mono",ui-monospace,Consolas,monospace;position:relative;min-height:120px}
.row{position:absolute;left:0;right:0;height:18px;display:flex;gap:8px;padding:0 8px;cursor:pointer;white-space:pre;color:#cbd5e1}
.row:hover{background:#1a2e4a}
.row.on{background:linear-gradient(90deg,#1d4ed8,#1e40af);color:#fff}
.row .n{color:#4b5d75;width:30px;text-align:right;flex:none}
.row.on .n{color:#bfdbfe}
.seq{max-height:44%;overflow:auto}
.seqh{font-size:10.5px;font-weight:700;letter-spacing:.08em;color:var(--sim-muted);padding:9px 12px;border-bottom:1px solid var(--sim-border);background:var(--sim-panel2)}
.op{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12.5px;cursor:pointer;position:relative}
.op:hover{background:#17283f}.op.on{background:#1a3152}
.op .dot{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.06)}
.op .t{margin-left:auto;color:var(--sim-muted);font-variant-numeric:tabular-nums}
.op .tn{color:var(--sim-muted);font:11px ui-monospace,monospace}
.op .bar{position:absolute;left:0;bottom:0;height:2px;background:var(--sim-accent2)}
.setup{font-size:10px;font-weight:700;color:var(--sim-muted);padding:8px 12px 3px;letter-spacing:.08em}
.transport{padding:4px 12px 12px;display:flex;flex-direction:column;gap:10px}
.tlwrap{position:relative;height:22px;cursor:pointer}
.tl{position:absolute;inset:6px 0;border-radius:6px;overflow:hidden;display:flex;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.tl span{height:100%;opacity:.9}
.done{position:absolute;left:0;top:6px;bottom:6px;background:rgba(255,255,255,.22);border-radius:6px 0 0 6px;pointer-events:none}
.tick{position:absolute;top:3px;width:2px;height:16px;background:#facc15;border-radius:1px;pointer-events:none}
.head{position:absolute;top:0;width:14px;height:22px;margin-left:-7px;border-radius:7px;background:#fff;box-shadow:0 0 0 3px var(--sim-accent),0 4px 10px rgba(0,0,0,.4);pointer-events:none}
.bar1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.grp{display:inline-flex;align-items:center;gap:4px;background:var(--sim-panel);border:1px solid var(--sim-border);border-radius:12px;padding:4px}
.tb{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;border:0;background:none;color:var(--sim-text);cursor:pointer}
.tb:hover{background:#1c2f4a}
.tb.play{width:46px;height:46px;border-radius:50%;background:linear-gradient(180deg,#4f8ff7,#2563eb);color:#fff;box-shadow:0 6px 16px rgba(37,99,235,.45)}
.tb.play:hover{background:linear-gradient(180deg,#60a5fa,#2563eb)}
.tb.play svg{width:20px;height:20px}
select{background:var(--sim-panel2);color:var(--sim-text);border:1px solid var(--sim-border);border-radius:8px;padding:6px 8px;font-size:12px}
.lbl{font-size:11px;color:var(--sim-muted);margin:0 2px 0 6px}
.tog{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--sim-muted);cursor:pointer;padding:6px 8px;border-radius:8px;user-select:none}
.tog:hover{color:var(--sim-text);background:#17283f}
.tog input{accent-color:var(--sim-accent)}
.seg{display:inline-flex;background:var(--sim-panel);border:1px solid var(--sim-border);border-radius:10px;overflow:hidden;padding:3px;gap:2px}
.seg button{background:none;border:0;color:var(--sim-muted);padding:6px 10px;cursor:pointer;font-size:12px;border-radius:7px}
.seg button:hover{color:var(--sim-text)}
.seg button.on{background:var(--sim-accent);color:#fff}
.time{margin-left:auto;font:600 15px "JetBrains Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--sim-text)}
.time small{color:var(--sim-muted);font-weight:400;font-size:11px;margin-left:4px}
.legend{color:var(--sim-muted);font-size:11px}
@media (max-width:900px){.main{flex-direction:column}.side{width:auto;margin:0 10px 10px}.view{min-height:340px}.dro{min-width:0}.axes span{font-size:18px}}
`;

const HTML = `
<div class="root">
 <div class="main">
  <div class="view">
   <div class="canvas"></div>
   <div class="loading">Preparing simulation…</div>
   <div class="dro glass">
    <div class="dhead"><span class="chip op" id="op">—</span><span class="chip" id="setup">—</span><span class="chip off" id="mode">—</span></div>
    <div class="axes"><b>X</b><span id="x">0.000</span><b>Z</b><span id="z">0.000</span></div>
    <div class="meta">
     <div><i>F</i><span id="feed">—</span></div><div><i>S</i><span id="rpm">—</span></div>
     <div><i>T</i><span id="tool">—</span></div><div><i>N</i><span id="line">—</span></div>
     <div class="spin" id="spin">${ICON.spindle}<span id="dir">STOP</span></div><div><span class="chip off" id="cool">Coolant off</span></div>
    </div>
   </div>
   <div class="fps glass"></div>
   <div class="note glass" hidden></div>
   <div class="alarms glass" hidden></div>
   <div class="vtools"><div class="scale glass"><span></span><i></i></div><button class="ibtn fs" title="Full screen (Enter)">${ICON.full}<span>Full screen</span></button></div>
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
  <div class="tlwrap"><div class="tl"></div><div class="done"></div><div class="ticks"></div><div class="head"></div></div>
  <div class="bar1">
   <span class="grp">
    <button class="tb" data-act="restart" title="Restart">${ICON.restart}</button>
    <button class="tb" data-act="back" title="Previous move (Left arrow)">${ICON.back}</button>
    <button class="tb play" data-act="play" title="Play / pause (Space)">${ICON.play}</button>
    <button class="tb" data-act="fwd" title="Next move (Right arrow)">${ICON.fwd}</button>
    <button class="tb" data-act="end" title="Jump to end">${ICON.end}</button>
   </span>
   <span class="grp"><span class="lbl">Speed</span><select class="speed" aria-label="Speed"></select>
    <label class="tog"><input type="checkbox" class="realtime"> Real time</label></span>
   <span class="seg views"><button data-view="iso" class="on">Iso</button><button data-view="front">Front</button><button data-view="top">Top</button><button data-view="follow">Follow tool</button></span>
   <span class="seg look"><button data-look="real" class="on">Realistic</button><button data-look="video">Video style</button><button data-look="enhanced">Enhanced</button></span>
   <span class="grp"><span class="lbl">Quality</span><select class="quality" aria-label="Quality"><option value="auto">Auto</option><option value="high">High</option><option value="balanced">Balanced</option><option value="fast">Fast</option></select></span>
   <span class="time"></span>
  </div>
  <div class="bar1">
   <label class="tog"><input type="checkbox" class="cutaway" checked> Cut-away</label>
   <label class="tog"><input type="checkbox" class="paths" checked> Tool path</label>
   <label class="tog"><input type="checkbox" class="fxon" checked> Chips &amp; coolant</label>
   <label class="tog"><input type="checkbox" class="loop"> Loop</label>
   <label class="tog"><input type="checkbox" class="single"> Single block</label>
   <label class="tog"><input type="checkbox" class="optstop"> M01 stop</label>
   <label class="tog extras-l" hidden><input type="checkbox" class="extras"> N33/N34</label>
   <span class="legend" style="margin-left:auto">Drag to orbit · right-drag to pan · wheel to zoom · Space play/pause · ←/→ step · Enter full screen · F fps</span>
  </div>
 </div>
</div>`;

const fmt = (s0: number) => {
  const s = Number.isFinite(s0) ? Math.max(0, s0) : 0;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export class CncSimulator extends HTMLElement {
  static get observedAttributes() {
    return ['program-url', 'speed', 'bar-diameter', 'part-length'];
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
  private stock: JobOptions['stock'];
  private cleanups: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private dragging = false;
  private removedNow = 0;
  private autoQuality = true;
  private qFrames = 0;
  private qTime = 0;
  private qGood = 0;
  private spinRate = 0;

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
    if (name === 'bar-diameter' || name === 'part-length')
      this.setStock({
        diameter: Number(this.getAttribute('bar-diameter')) || null,
        length: Number(this.getAttribute('part-length')) || null,
      });
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
    // M99 Pn at the top: the machine jumps to Nn, so start where the machine starts (N4 for O0003).
    const head = text.split(/\r?\n/).slice(0, 6).join('\n');
    this.mode = /^\s*M99\s*P\d+/m.test(head) ? 'machine' : 'full';
    await this.compute();
  }

  /** The part's bar: diameter and finished length (mm). Face stock is added at both ends. */
  setStock(stock: JobOptions['stock']) {
    const same =
      (stock?.diameter ?? null) === (this.stock?.diameter ?? null) &&
      (stock?.length ?? null) === (this.stock?.length ?? null);
    this.stock = stock ?? undefined;
    if (!same && this.text && this.scene) void this.compute();
  }

  /** Safety checks of the loaded program (rapids through material, spindle off, past centre). */
  get checks(): SimCheck[] {
    return this.data?.job.checks ?? [];
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

  /** Fill the whole screen with the simulator (Esc or the button again to leave). */
  toggleFullscreen() {
    if (document.fullscreenElement === this) void document.exitFullscreen?.();
    else void this.requestFullscreen?.().catch(() => undefined);
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
    (this.$('.loading') as HTMLElement).textContent = 'Preparing simulation…';
    let data: Precomputed;
    try {
      // the main thread draws with the same bar the worker cuts
      applyStock(this.stock);
      this.grid = new Grid();
      data = await this.runner.run(this.text, { mode: this.mode, extras, stock: this.stock });
    } catch (e) {
      this.$('.loading').textContent = `Could not simulate this program: ${(e as Error).message}`;
      return;
    }
    if (!this.scene) return;
    if (data.job.count === 0) {
      this.data = null;
      this.$('.loading').textContent = 'Nothing to simulate: the program has no tool moves.';
      return;
    }
    this.data = data;
    this.$('.loading').style.display = 'none';
    this.scene.setJob(data.job);
    this.curLine = this.curOp = -1;
    this.shownTool = -1;
    this.renderSide();
    this.renderTimeline();
    this.renderNote();
    this.renderAlarms();
    this.seek(0);
    for (const w of data.job.warnings)
      this.dispatchEvent(new CustomEvent('warning', { detail: { message: w } }));
    const checks = data.job.checks;
    this.dispatchEvent(
      new CustomEvent('checks', {
        detail: { checks, errors: checks.filter((c) => c.severity === 'error').length },
      }),
    );
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
    on('[data-act="back"]', 'click', () => this.stepMove(-1));
    on('[data-act="fwd"]', 'click', () => this.stepMove(1));
    on('.quality', 'change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.autoQuality = v === 'auto';
      if (!this.autoQuality) this.scene?.setQuality(v as Quality);
      this.dirty = true;
      this.kick();
    });
    on('.fxon', 'change', (e) => {
      this.scene?.setEffects((e.target as HTMLInputElement).checked);
      this.kick();
    });
    on('.fs', 'click', () => this.toggleFullscreen());
    const fsChange = () => {
      (this.$('.fs span') as HTMLElement).textContent =
        document.fullscreenElement === this ? 'Exit full screen' : 'Full screen';
      requestAnimationFrame(() => this.resize());
    };
    document.addEventListener('fullscreenchange', fsChange);
    this.cleanups.push(() => document.removeEventListener('fullscreenchange', fsChange));
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
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.toggleFullscreen();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.stepMove(e.key === 'ArrowLeft' ? -1 : 1);
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
    this.$('[data-act="play"]').innerHTML = this.playing ? ICON.pause : ICON.play;
  }

  /** Go to the start of the previous / next move. */
  private stepMove(dir: -1 | 1) {
    if (!this.data) return;
    this.pause();
    const job = this.data.job;
    const i = Math.max(0, moveAt(job.moves, job.count, this.t));
    const k = Math.max(0, Math.min(job.count - 1, i + dir));
    this.seek(dir > 0 ? job.moves[k * STRIDE + F.t0] + 1e-6 : job.moves[k * STRIDE + F.t0] + 1e-6);
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

  private renderAlarms() {
    const box = this.$('.alarms');
    const job = this.data?.job;
    if (!job) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const list = job.checks;
    if (!list.length) {
      box.className = 'alarms glass ok';
      box.innerHTML =
        '<h4>✓ Safety checks passed</h4>No rapid through metal · spindle on for every cut · no tool past centre';
      return;
    }
    box.className = 'alarms glass';
    const esc = (t: string) =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
    box.innerHTML =
      `<h4>⚠ ${list.length} safety ${list.length === 1 ? 'alarm' : 'alarms'}</h4>` +
      list
        .map(
          (c, k) =>
            `<button data-k="${k}" title="Go to this move"><b>Line ${c.line}</b>${esc(c.message)}</button>`,
        )
        .join('');
    box.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const c = list[Number(b.dataset.k)];
        this.pause();
        this.seek(Math.max(0, c.time - 0.05));
        this.kick();
      };
    });
  }

  private renderTimeline() {
    const job = this.data!.job;
    const d = job.duration || 1;
    this.$('.tl').innerHTML = job.ops
      .map((o) => `<span style="width:${((o.t1 - o.t0) / d) * 100}%;background:${o.colour}"></span>`)
      .join('');
    this.$('.ticks').innerHTML =
      job.toolChanges.map((t) => `<i class="tick" style="left:${(t / d) * 100}%"></i>`).join('') +
      job.checks
        .map((c) => `<i class="alarm" style="left:${(c.time / d) * 100}%" title="Line ${c.line}"></i>`)
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
      // rapids accelerate and brake (display only; times are unchanged)
      const fe = m[o + F.type] === 0 ? f * f * (3 - 2 * f) : f;
      const z = m[o + F.z0] + (m[o + F.z1] - m[o + F.z0]) * fe;
      const x = m[o + F.x0] + (m[o + F.x1] - m[o + F.x0]) * fe;
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
      // spindle: speeds up / slows down instead of jumping (visual speed capped)
      const rpm = m[o + F.rpm];
      const want =
        this.playing && rpm ? (rpm > 0 ? -1 : 1) * Math.min(Math.abs(rpm) / 60, SIM_CONFIG.spinCap) : 0;
      this.spinRate += (want - this.spinRate) * Math.min(1, dt * 2.5);
      if (Math.abs(this.spinRate) > 1e-3) {
        this.spinAngle += this.spinRate * 2 * Math.PI * dt;
        busy = true;
      }
      const cutting = this.removedNow > 0 && m[o + F.type] !== 0;
      const rate = dt > 0 ? this.removedNow / dt : 0;
      if (scene.effects(dt, cutting, this.playing, rate, m[o + F.coolant] === 1)) busy = true;
      if (!this.playing) this.removedNow = 0;
      const cutaway = this.$<HTMLInputElement>('.cutaway').checked;
      scene.spin(this.spinAngle, !cutaway);
      // part mesh at most meshHz, or while the yellow fade runs
      const fading = this.t - this.lastCutT < SIM_CONFIG.fadeSeconds + 0.5;
      if (
        (grid.version !== this.meshVersion || (fading && this.playing)) &&
        now - this.lastMesh > 1000 / scene.meshHz
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
      if (busy && this.autoQuality && dt > 0) this.tuneQuality(dt);
    }
    if (this.fpsOn) {
      this.fpsFrames++;
      if (now - this.fpsT > 500) {
        this.$('.fps').textContent =
          `${Math.round((this.fpsFrames * 1000) / (now - this.fpsT))} fps · ${scene.qualityLevel}`;
        this.fpsFrames = 0;
        this.fpsT = now;
      }
      busy = true;
    }
    // keep looping while playing/animating/damping; otherwise sleep until the next event
    if (busy) this.raf = requestAnimationFrame(this.loop);
  };

  /** Auto quality: under ~45 fps step down, steady 58+ fps step back up. */
  private tuneQuality(dt: number) {
    const scene = this.scene;
    if (!scene) return;
    this.qFrames++;
    this.qTime += dt;
    if (this.qTime < 2) return;
    const fps = this.qFrames / this.qTime;
    this.qFrames = 0;
    this.qTime = 0;
    const order: Quality[] = ['fast', 'balanced', 'high'];
    const k = order.indexOf(scene.qualityLevel);
    if (fps < 45 && k > 0) {
      scene.setQuality(order[k - 1]);
      this.qGood = 0;
    } else if (fps > 58) {
      if (++this.qGood >= 3 && k < order.length - 1) {
        scene.setQuality(order[k + 1]);
        this.qGood = 0;
      }
    } else this.qGood = 0;
  }

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
    // digital readout (text only, no re-layout)
    const set = (id: string, v: string) => {
      const el = this.root.getElementById(id);
      if (el && el.textContent !== v) el.textContent = v;
    };
    const type = m[o + F.type];
    set('op', op.name);
    set('setup', setup.name);
    const modeEl = this.root.getElementById('mode');
    const modeTxt =
      type === 0
        ? 'Rapid'
        : type === 1
          ? 'Feed'
          : type === 2
            ? 'Thread'
            : type === 3
              ? 'Dwell'
              : 'Tool change';
    set('mode', modeTxt);
    if (modeEl) modeEl.className = `chip ${type === 0 ? 'rapid' : type === 1 || type === 2 ? 'on' : 'off'}`;
    set('x', x.toFixed(3));
    set('z', z.toFixed(3));
    set(
      'feed',
      feed >= 0
        ? `${feed.toFixed(0)} mm/min${m[o + F.feedRev] >= 0 ? ` · ${m[o + F.feedRev].toFixed(2)}/rev` : ''}`
        : '—',
    );
    set('rpm', rpm ? `${Math.abs(rpm).toFixed(0)} rpm` : '0 rpm');
    set('tool', tool ? `T${String(tool).padStart(2, '0')}` : '—');
    set('line', String(line));
    set('dir', rpm ? (rpm > 0 ? 'M03 CW' : 'M04 CCW') : 'M05 STOP');
    const spin = this.root.getElementById('spin');
    if (spin) spin.className = `spin${rpm && this.playing ? ' run' : ''}${rpm < 0 ? ' ccw' : ''}`;
    const cool = this.root.getElementById('cool');
    const coolOn = m[o + F.coolant] === 1;
    set('cool', coolOn ? 'Coolant on' : 'Coolant off');
    if (cool) cool.className = `chip ${coolOn ? 'on' : 'off'}`;
    this.$('.time').innerHTML = `${fmt(this.t)}<small>/ ${fmt(job.duration)} estimate</small>`;
    const d = job.duration || 1;
    this.$('.head').style.left = `${(this.t / d) * 100}%`;
    this.$('.done').style.width = `${(this.t / d) * 100}%`;
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

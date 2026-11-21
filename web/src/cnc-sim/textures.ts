/**
 * Procedural textures (drawn once on a canvas, no image files): turned-surface feed marks,
 * brushed metal, painted casting, view-cube labels, soft dots.
 */
import * as THREE from 'three';

/** Draw on a canvas; where there is no 2D canvas (tests, locked-down browsers) a blank texture. */
function make(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  let g: CanvasRenderingContext2D | null = null;
  try {
    g = c.getContext('2d');
  } catch {
    g = null;
  }
  if (!g) return new THREE.Texture();
  draw(g);
  return new THREE.CanvasTexture(c);
}

/** Deterministic noise so every load looks the same. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const repeat = (t: THREE.Texture) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

/**
 * Turned surface: fine circumferential feed marks (lines across v, along the circumference u).
 * Used as roughness + bump map; v repeats every 2 mm of length (about 0.2 mm feed).
 */
export function turnedTexture(): THREE.Texture {
  const t = make(64, 512, (g) => {
    const r = rng(7);
    for (let y = 0; y < 512; y += 1) {
      const phase = (y % 51.2) / 51.2;
      const groove = Math.pow(Math.sin(phase * Math.PI), 6);
      const v = Math.round(120 + groove * 90 + (r() - 0.5) * 18);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(0, y, 64, 1);
    }
  });
  t.anisotropy = 4;
  return repeat(t);
}

/** Brushed metal: long fine streaks (roughness map). */
export function brushedTexture(seed = 3): THREE.Texture {
  return repeat(
    make(256, 256, (g) => {
      const r = rng(seed);
      g.fillStyle = '#8c8c8c';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 900; i++) {
        const y = r() * 256;
        const v = Math.round(110 + r() * 90);
        g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
        g.lineWidth = r() * 1.2 + 0.3;
        g.beginPath();
        const x0 = r() * 256;
        g.moveTo(x0, y);
        g.lineTo(x0 + 60 + r() * 180, y + (r() - 0.5) * 2);
        g.stroke();
      }
    }),
  );
}

/** Painted casting: soft mottling (bump / roughness). */
export function paintTexture(seed = 11): THREE.Texture {
  return repeat(
    make(256, 256, (g) => {
      const r = rng(seed);
      g.fillStyle = '#808080';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2500; i++) {
        const v = Math.round(100 + r() * 60);
        g.fillStyle = `rgba(${v},${v},${v},0.25)`;
        g.beginPath();
        g.arc(r() * 256, r() * 256, r() * 6 + 1, 0, Math.PI * 2);
        g.fill();
      }
    }),
  );
}

/** Square label for the view cube / axis triad. */
export function labelTexture(text: string, bg: string, fg: string, size = 128, border = true): THREE.Texture {
  const t = make(size, size, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);
    if (border) {
      g.strokeStyle = '#94a3b8';
      g.lineWidth = 6;
      g.strokeRect(3, 3, size - 6, size - 6);
    }
    g.fillStyle = fg;
    g.font = `600 ${Math.round(size / 5.2)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, size / 2, size / 2);
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round sprite (coolant droplets, spark). */
export function dotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.Texture {
  const t = make(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

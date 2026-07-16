import { useEffect, useRef } from "react";
import { useTheme } from "../lib/theme";

/**
 * Constellation-style ambient particle field.
 *
 * Reads accent colours from CSS variables so it adapts to whichever theme is
 * active (CRT dark vs blueprint light). Particles drift slowly and draw thin
 * connecting lines when they're near each other. A slow horizontal sweep
 * beam crosses the field every ~6 s to add motion without strobing.
 *
 * Cheap: ~70 particles, O(n²) link check capped via spatial early-out.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hue: number; // 0..palette.length-1
  twinkle: number;
}

const LINK_DIST = 110;
const DENSITY_RATIO = 16000; // 1 particle per N pixels — adapts to viewport
const MAX_PARTICLES = 120;
const SWEEP_PERIOD_MS = 9000;

function readPalette(): string[] {
  const css = getComputedStyle(document.documentElement);
  // Theme tokens are space-separated channel triplets ("6 66 92"). Join with
  // commas so the later `.replace("rgb","rgba").replace(")",",α)")` tricks
  // produce VALID colors — `rgba(6 66 92,0.08)` mixes the two syntaxes and
  // made addColorStop throw, killing the whole animation on frame one.
  const get = (name: string) =>
    `rgb(${css.getPropertyValue(name).trim().split(/\s+/).join(",")})`;
  return [get("--accent"), get("--accent2"), get("--good"), get("--warn"), get("--bad")];
}

export function ParticleField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const [theme] = useTheme();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let palette = readPalette();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = window.innerWidth;
    let h = window.innerHeight;

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const count = Math.min(MAX_PARTICLES, Math.floor((w * h) / DENSITY_RATIO));
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        size: Math.random() * 1.2 + 0.6,
        hue: Math.floor(Math.random() * palette.length),
        twinkle: Math.random() * Math.PI * 2,
      });
    }

    let start = performance.now();
    let lastPaletteCheck = start;

    function tick(now: number) {
      if (!ctx) return;
      const elapsed = now - start;

      // Cheap palette refresh — re-read every 1.5 s so a theme toggle is
      // picked up without remounting the canvas (we also have a theme-keyed
      // useEffect, but this catches mid-frame token tweaks too).
      if (now - lastPaletteCheck > 1500) {
        palette = readPalette();
        lastPaletteCheck = now;
      }

      ctx.clearRect(0, 0, w, h);

      // -- 1. Sweep beam — a soft horizontal band that scrolls top→bottom.
      const sweepT = (elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
      const sweepY = sweepT * (h + 200) - 100;
      const grad = ctx.createLinearGradient(0, sweepY - 90, 0, sweepY + 90);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, palette[0].replace("rgb", "rgba").replace(")", ",0.08)"));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, sweepY - 90, w, 180);

      // -- 2. Links — light line if two particles are close.
      ctx.lineWidth = 0.6;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]!;
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]!;
          const dx = a.x - b.x;
          if (dx > LINK_DIST || dx < -LINK_DIST) continue;
          const dy = a.y - b.y;
          if (dy > LINK_DIST || dy < -LINK_DIST) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST * LINK_DIST) continue;
          const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.32;
          ctx.strokeStyle = palette[a.hue]
            .replace("rgb", "rgba")
            .replace(")", `,${alpha.toFixed(3)})`);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // -- 3. Particles — crisp dots, no glow halos (per design feedback).
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.twinkle += 0.02;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;
        const a = 0.55 + Math.sin(p.twinkle) * 0.25;
        ctx.fillStyle = palette[p.hue]
          .replace("rgb", "rgba")
          .replace(")", `,${a.toFixed(3)})`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    function onResize() {
      resize();
    }
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [theme]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        mixBlendMode: theme === "dark" ? "screen" : "multiply",
        opacity: theme === "dark" ? 0.85 : 0.45,
      }}
    />
  );
}

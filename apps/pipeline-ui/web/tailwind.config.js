/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        display: ['"Orbitron"', '"JetBrains Mono"', "sans-serif"],
        vt: ['"VT323"', '"JetBrains Mono"', "monospace"],
      },
      colors: {
        // Semantic tokens consumed via CSS vars defined in index.css.
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        panel2: "rgb(var(--panel2) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        accent2: "rgb(var(--accent2) / <alpha-value>)",
        good: "rgb(var(--good) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        bad: "rgb(var(--bad) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        // Direct neon aliases for explicit cyberpunk accents.
        "neon-cyan": "rgb(var(--accent) / <alpha-value>)",
        "neon-violet": "rgb(var(--accent2) / <alpha-value>)",
        "neon-amber": "rgb(var(--warn) / <alpha-value>)",
        "neon-lime": "rgb(var(--good) / <alpha-value>)",
        "neon-magenta": "rgb(var(--bad) / <alpha-value>)",
      },
      boxShadow: {
        // Crisp 1-2 px inset outlines, no diffuse halos. The HUD aesthetic
        // is "bright outline" — glow lives only on small focal indicators.
        glow: "inset 0 0 0 1px rgb(var(--accent) / 0.9)",
        card: "inset 0 0 0 1px rgb(var(--accent) / 0.45)",
        "edge-cyan": "inset 0 0 0 1px rgb(var(--accent) / 0.85)",
        "edge-violet": "inset 0 0 0 1px rgb(var(--accent2) / 0.85)",
        "edge-amber": "inset 0 0 0 1px rgb(var(--warn) / 0.85)",
        // Kept for tiny indicator dots only — the inset halo doesn't bleed.
        "neon-cyan": "0 0 6px rgb(var(--accent) / 0.55)",
        "neon-violet": "0 0 6px rgb(var(--accent2) / 0.55)",
        "neon-amber": "0 0 6px rgb(var(--warn) / 0.55)",
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.85)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        floatIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scan: {
          "0%": { backgroundPosition: "0 0" },
          "100%": { backgroundPosition: "0 100vh" },
        },
        flicker: {
          "0%, 19%, 21%, 23%, 25%, 54%, 56%, 100%": { opacity: "1" },
          "20%, 24%, 55%": { opacity: "0.6" },
        },
        marching: {
          to: { strokeDashoffset: "-16" },
        },
        pulseGlow: {
          "0%, 100%": { filter: "drop-shadow(0 0 4px currentColor)" },
          "50%": { filter: "drop-shadow(0 0 14px currentColor)" },
        },
        boot: {
          from: { width: "0" },
          to: { width: "100%" },
        },
        blink: {
          to: { visibility: "hidden" },
        },
      },
      animation: {
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
        shimmer: "shimmer 2.4s linear infinite",
        floatIn: "floatIn 0.35s ease-out forwards",
        scan: "scan 8s linear infinite",
        flicker: "flicker 6s infinite",
        marching: "marching 1.2s linear infinite",
        pulseGlow: "pulseGlow 2.4s ease-in-out infinite",
        boot: "boot 1.4s steps(20, end) forwards",
        blink: "blink 1s steps(2, start) infinite",
      },
    },
  },
  plugins: [],
};

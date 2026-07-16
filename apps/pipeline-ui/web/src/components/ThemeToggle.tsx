import { motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme";

/** Two-slot moon/sun switch. The knob slides over the active side; the idle
 *  side stays visible but muted so both options read at a glance. */
export function ThemeToggle() {
  const [theme, , toggle] = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="
        group relative inline-flex h-8 w-[60px] items-center border border-accent/50
        bg-canvas/70 px-1 transition-colors hover:border-accent
        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
      "
    >
      <span className="pointer-events-none absolute inset-0 flex items-center justify-between px-[7px]">
        <Moon size={13} strokeWidth={2.2} className={isDark ? "text-accent" : "text-muted/50"} />
        <Sun size={13} strokeWidth={2.2} className={isDark ? "text-muted/50" : "text-accent"} />
      </span>
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        className="
          relative z-10 grid h-6 w-6 place-items-center border-2 border-accent
          bg-canvas text-accent
        "
        style={{ marginLeft: isDark ? 0 : 26 }}
      >
        {isDark ? <Moon size={13} strokeWidth={2.4} /> : <Sun size={13} strokeWidth={2.4} />}
      </motion.span>
    </button>
  );
}

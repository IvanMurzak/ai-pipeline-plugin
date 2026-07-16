import { GitBranch, LayoutDashboard, Radio } from "lucide-react";

export type MobilePane = "left" | "middle" | "right";

interface Props {
  value: MobilePane;
  onChange: (pane: MobilePane) => void;
  /** Active-run count badge on the Runs tab. */
  activeCount: number;
}

/** Bottom navigation for phones — below lg the shell shows ONE pane at a
 *  time and this bar switches between them. Hidden entirely on desktop. */
export function MobileNav({ value, onChange, activeCount }: Props) {
  const items: Array<{ pane: MobilePane; label: string; icon: React.ReactNode; badge?: number }> = [
    { pane: "left", label: "Runs", icon: <GitBranch size={17} strokeWidth={2.2} />, badge: activeCount },
    { pane: "middle", label: "Board", icon: <LayoutDashboard size={17} strokeWidth={2.2} /> },
    { pane: "right", label: "Live", icon: <Radio size={17} strokeWidth={2.2} /> },
  ];
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t frame-divider bg-canvas/90 backdrop-blur-md lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Sections"
    >
      <div className="flex">
        {items.map((it) => {
          const active = value === it.pane;
          return (
            <button
              key={it.pane}
              type="button"
              onClick={() => onChange(it.pane)}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <span
                className={`absolute inset-x-6 top-0 h-0.5 ${active ? "bg-accent" : "bg-transparent"}`}
                aria-hidden
              />
              <span className="relative">
                {it.icon}
                {it.badge != null && it.badge > 0 && (
                  <span className="absolute -right-2.5 -top-1.5 grid min-w-[16px] place-items-center rounded-full bg-accent px-1 font-mono text-[9px] font-bold leading-4 text-canvas">
                    {it.badge}
                  </span>
                )}
              </span>
              {it.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

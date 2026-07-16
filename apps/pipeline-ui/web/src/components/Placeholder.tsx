/** Centered muted placeholder filling a pane ("pick a project…" states). */
export function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface flex h-full items-center justify-center p-6 text-center text-xs text-muted">
      {children}
    </div>
  );
}

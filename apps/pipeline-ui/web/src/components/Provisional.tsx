/**
 * Marks a number as PROVISIONAL: it came from the client's event fold, not the
 * transcript fold, so it is a floor rather than a count.
 *
 * The hook events (`tool.called` / `turn.usage`) leak run-id correlation and
 * never see subagent tokens, so their numbers undercount — sometimes by a lot.
 * We still show them, because a number now beats a blank while the transcript
 * fold resolves, but they must never look authoritative: `~` + muted tone +
 * a tooltip that says why.
 */

export function Provisional({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-muted/70"
      title="Provisional — counted from hook events, which undercount. Replaced by the transcript fold once it resolves."
    >
      ~{children}
    </span>
  );
}

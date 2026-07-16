import { useEffect, useState } from "react";

/** A once-per-second clock, enabled only while something live is on screen —
 *  drives ticking "elapsed" readouts. Keep it in LEAF components (the chip or
 *  badge that shows the time), never at a panel/tree root: the hook re-renders
 *  its host every second. */
export function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

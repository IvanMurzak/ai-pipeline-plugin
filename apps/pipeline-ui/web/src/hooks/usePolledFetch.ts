/**
 * The polling discipline shared by every per-run data hook (run-stats,
 * run-steps): fetch on key change, re-poll on an interval while `live`,
 * fetch once when terminal.
 *
 * Two load-bearing details both consumers inherit:
 *   - State clears immediately ONLY when the key changes, so a newly-selected
 *     run never momentarily shows the previous run's data. Deliberately NOT
 *     keyed on `live`: a live→terminal transition must not blank the panel
 *     before the refetch lands.
 *   - A payload identical to the previous one is NOT re-set — polling a
 *     parked run every few seconds otherwise mints fresh object identities
 *     that re-render the whole consuming subtree for no change.
 */

import { useEffect, useRef, useState } from "react";

const LIVE_POLL_MS = 4000;

export function usePolledFetch<T>(
  fetcher: (() => Promise<T | null>) | null,
  key: string | null,
  live: boolean,
): T | null {
  const [data, setData] = useState<T | null>(null);
  const lastRaw = useRef<string | null>(null);

  useEffect(() => {
    setData(null);
    lastRaw.current = null;
  }, [key]);

  useEffect(() => {
    if (!fetcher || key === null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await fetcher();
        if (cancelled) return;
        const raw = JSON.stringify(d);
        if (raw === lastRaw.current) return;
        lastRaw.current = raw;
        setData(d);
      } catch {
        /* keep the previous value; consumers render their fallback */
      }
    };
    load();
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(load, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);

  return data;
}

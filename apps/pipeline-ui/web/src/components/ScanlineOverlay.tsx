/**
 * ScanlineOverlay — fixed full-viewport CRT overlay with scanlines + vignette.
 * Placed once at the App root. Uses `.crt-scanlines` / `.crt-vignette` from
 * index.css so the look adapts automatically per theme.
 */
export function ScanlineOverlay() {
  return (
    <>
      <div className="crt-scanlines" aria-hidden />
      <div className="crt-vignette" aria-hidden />
    </>
  );
}

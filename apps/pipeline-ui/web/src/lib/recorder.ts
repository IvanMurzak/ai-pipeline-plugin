/** Minimal MediaRecorder wrapper for dictation capture. Picks the best
 *  container the browser can produce (webm/opus everywhere except Safari,
 *  which records mp4/aac) — the server's STT proxy accepts both. */

export interface ActiveRecording {
  /** Stop and resolve the captured audio. */
  stop(): Promise<Blob>;
  /** Abort without keeping the audio. */
  cancel(): void;
  mimeType: string;
}

export function recordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export async function startRecording(): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const releaseMic = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  rec.start(250);
  return {
    mimeType: rec.mimeType || mimeType || "audio/webm",
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          releaseMic();
          resolve(new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }));
        };
        try {
          rec.stop();
        } catch {
          releaseMic();
          resolve(new Blob(chunks, { type: mimeType || "audio/webm" }));
        }
      }),
    cancel: () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      releaseMic();
    },
  };
}

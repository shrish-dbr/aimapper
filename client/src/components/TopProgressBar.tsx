import { useEffect, useRef, useState } from 'react';
import { subscribeActivity } from '../lib/requestActivity';

// A slim top-of-page loading bar (YouTube/GitHub style) driven by real in-flight
// QUICK API requests (long operations show in the ActivityTray instead, and
// background polls are silent). It only appears if a request outlasts
// SHOW_DELAY_MS, so quick loads never flash it. While shown it eases toward ~90%
// (so it feels responsive without ever "finishing" early); when all requests
// settle it snaps to 100% and fades out. Page-agnostic — one bar covers every
// navigation/data fetch.
// reconstructed: the comment wording after "outlasts" and the SHOW_DELAY_MS value (300) were not visible in the screenshots.
const SHOW_DELAY_MS = 300; // reconstructed

export function TopProgressBar() {
  const [progress, setProgress] = useState(0); // 0..100
  const [visible, setVisible] = useState(false);
  const activeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownRef = useRef(false); // did the bar actually appear for this burst?

  useEffect(() => {
    const clearTimers = () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (hideRef.current) { clearTimeout(hideRef.current); hideRef.current = null; }
      if (showRef.current) { clearTimeout(showRef.current); showRef.current = null; }
    };

    const unsub = subscribeActivity((active) => {
      if (active === activeRef.current) return;
      activeRef.current = active;

      if (active) {
        // Start (or resume) the trickle toward 90% — but only once the burst has
        // lasted SHOW_DELAY_MS (or immediately if the bar is already on screen).
        clearTimers();
        const start = () => {
          shownRef.current = true;
          setVisible(true);
          setProgress((p) => (p > 0 && p < 90 ? p : 10));
          timerRef.current = setInterval(() => {
            setProgress((p) => (p >= 90 ? p : p + Math.max(0.5, (90 - p) * 0.08)));
          }, 200);
        };
        if (shownRef.current) start();
        else showRef.current = setTimeout(start, SHOW_DELAY_MS);
      } else {
        clearTimers();
        if (!shownRef.current) return; // finished before the delay — never shown
        // Complete: snap to 100%, then fade and reset.
        shownRef.current = false;
        setProgress(100);
        hideRef.current = setTimeout(() => {
          setVisible(false);
          // Reset after the fade so the next run starts clean.
          setTimeout(() => setProgress(0), 250);
        }, 300);
      }
    });

    return () => { unsub(); clearTimers(); };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px]"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 250ms ease' }}
    >
      <div
        className="h-full rounded-r-full bg-brand shadow-[0_0_8px_rgba(229,64,43,0.55)]"
        style={{ width: `${progress}%`, transition: 'width 200ms ease' }}
      />
    </div>
  );
}

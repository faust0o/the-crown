import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollLock } from "../crypto/useScrollLock";

/**
 * Blow an element up to fill the screen, and put it back.
 *
 * Two mechanisms, because neither reaches every screen. The caller pins the
 * element over the page with CSS while `full` is set, and on an iPhone that is
 * all there is — Safari there will only take a <video> fullscreen. Where the
 * browser does offer the Fullscreen API, the same element is handed to it as
 * well, which clears the browser's own chrome off the screen too.
 *
 * It is the element itself that grows rather than a copy mounted in an
 * overlay, so whatever is drawn inside keeps its state and simply resizes.
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [full, setFull] = useState(false);

  useScrollLock(full);

  const toggle = useCallback(() => {
    if (full) {
      setFull(false);
      return;
    }
    setFull(true);
    // Asked for in the click itself: the browser grants it only to a gesture.
    // Refused, the CSS view stands on its own.
    if (document.fullscreenEnabled) ref.current?.requestFullscreen().catch(() => {});
  }, [full]);

  useEffect(() => {
    if (!full) return;
    const el = ref.current;

    // Left by the browser's own way out — its Escape, or a swipe on Android —
    // the CSS view has to follow, or it would be left covering the page.
    const onChange = () => {
      if (document.fullscreenElement !== el) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog that lands over the chart answers its own Escape.
      if (document.querySelector('[aria-modal="true"]')) return;
      setFull(false);
    };

    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
      // However the view closed — the key, Escape, the component leaving —
      // the browser's fullscreen goes with it.
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    };
  }, [full]);

  return { ref, full, toggle };
}

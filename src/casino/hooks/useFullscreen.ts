import { useCallback, useEffect, useState } from "react";
import { useScrollLock } from "../crypto/useScrollLock";

/**
 * A view that fills the screen, and the browser's chrome taken off it.
 *
 * The caller pins its element over the page with CSS while `full` is set, and
 * on an iPhone that is all there is — Safari there will only take a <video>
 * fullscreen. Where the browser does offer the Fullscreen API, the whole page
 * is handed to it as well, which clears the browser's own bars too.
 *
 * The page, not the element. In fullscreen the browser draws nothing outside
 * the element it was given, so a bet's result landing while the chart was up
 * went unseen until the player came back out — and the element going away
 * took the fullscreen with it, which the round ending under the chart did.
 */
export function useFullscreen() {
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
    if (document.fullscreenEnabled) document.documentElement.requestFullscreen().catch(() => {});
  }, [full]);

  useEffect(() => {
    if (!full) return;

    // Left by the browser's own way out — its Escape, or a swipe on Android —
    // the CSS view has to follow, or it would be left covering the page.
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog that lands over the view answers its own Escape.
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
      if (document.fullscreenElement === document.documentElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, [full]);

  return { full, toggle };
}

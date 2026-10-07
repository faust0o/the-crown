import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

const PIECES = 150;
const GRAVITY = 0.32;
const DRAG = 0.986;
/** Paper flutters; it doesn't drop. Caps the fall once the burst has spent. */
const TERMINAL = 4.2;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  spinV: number;
  flip: number;
  flipV: number;
  wobble: number;
  w: number;
  h: number;
  round: boolean;
  color: string;
  ttl: number;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * A burst of paper from behind a win. Purely decorative.
 *
 * On a canvas portalled to <body>, not inside the dialog: the card animates in
 * on a transform, and a transformed ancestor turns `position: fixed` into
 * "fixed to the card" — the confetti would have been clipped to its corners.
 *
 * Colours are the theme's own up, gold and amber, read off the root at fire
 * time so the paper matches whichever theme the win landed in.
 */
export function Confetti({ origin }: { origin: RefObject<HTMLElement | null> }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.width = vw * dpr;
    el.height = vh * dpr;
    ctx.scale(dpr, dpr);

    const root = getComputedStyle(document.documentElement);
    const palette = ["--up", "--gold", "--accent", "--foreground"]
      .map((v) => root.getPropertyValue(v).trim())
      .filter(Boolean);
    // Up and gold carry the win; amber and ink are there for contrast, once each.
    const colors = [palette[0], palette[0], palette[1], palette[1], ...palette.slice(2)];

    let pieces: Piece[] = [];
    let raf = 0;
    let last = 0;

    const fire = () => {
      const rect = origin.current?.getBoundingClientRect();
      const ox = rect ? rect.left + rect.width / 2 : vw / 2;
      const oy = rect ? rect.top + rect.height / 2 : vh / 3;
      // Enough to clear the top of a phone and a desktop alike, not to leave it.
      const reach = Math.min(vh, 900) * 0.024;
      pieces = Array.from({ length: PIECES }, () => {
        // A cone opening upward, so it rises out of the coin before it falls.
        const angle = -Math.PI / 2 + rand(-1.15, 1.15);
        const speed = reach * rand(0.35, 1);
        const round = Math.random() < 0.25;
        return {
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          spin: rand(0, Math.PI * 2),
          spinV: rand(-0.2, 0.2),
          flip: rand(0, Math.PI * 2),
          flipV: rand(0.08, 0.22),
          wobble: rand(0, Math.PI * 2),
          w: round ? 6 : rand(6, 10),
          h: round ? 6 : rand(3.5, 5.5),
          round,
          color: colors[Math.floor(Math.random() * colors.length)],
          ttl: rand(2400, 3600),
        };
      });
      last = performance.now();
      const start = last;
      raf = requestAnimationFrame(function step(now) {
        // In frames at 60fps, so the constants read the same on a 120Hz screen,
        // and capped so a backgrounded tab doesn't come back to a teleport.
        const dt = Math.min(3, (now - last) / (1000 / 60));
        const age = now - start;
        last = now;

        ctx.clearRect(0, 0, vw, vh);
        let alive = 0;
        for (const p of pieces) {
          if (age > p.ttl) continue;
          alive++;
          p.vx *= Math.pow(DRAG, dt);
          p.vy = Math.min(TERMINAL, p.vy * Math.pow(DRAG, dt) + GRAVITY * dt);
          p.wobble += 0.1 * dt;
          p.x += (p.vx + Math.sin(p.wobble) * 0.6) * dt;
          p.y += p.vy * dt;
          p.spin += p.spinV * dt;
          p.flip += p.flipV * dt;

          ctx.save();
          ctx.globalAlpha = Math.min(1, (p.ttl - age) / 700);
          ctx.translate(p.x, p.y);
          ctx.rotate(p.spin);
          // Squashing one axis by the cosine is the paper turning over.
          ctx.scale(1, Math.cos(p.flip));
          ctx.fillStyle = p.color;
          if (p.round) {
            ctx.beginPath();
            ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          }
          ctx.restore();
        }
        if (alive) raf = requestAnimationFrame(step);
        else ctx.clearRect(0, 0, vw, vh);
      });
    };

    // Timed to the coin's pop, so the paper comes out of something.
    const timer = window.setTimeout(fire, 120);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [origin]);

  return createPortal(
    <canvas
      ref={canvas}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[70] h-full w-full"
    />,
    document.body
  );
}

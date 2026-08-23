import { useEffect, useRef, useState } from "react";

/**
 * Scrolls its text only when the text is actually wider than the box.
 *
 * Measuring first matters: animating every label would make short names drift
 * for no reason, and a marquee that runs when nothing is clipped reads as a bug.
 */
export function Marquee({ text, className = "" }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i) return;
    setOverflow(Math.max(0, i.scrollWidth - b.clientWidth));
  }, [text]);

  return (
    <span ref={box} className={`block overflow-hidden whitespace-nowrap ${className}`}>
      <span
        ref={inner}
        className="inline-block"
        style={
          overflow > 0
            ? {
                // Travel the overflow and back, so the end is readable and the
                // label returns to its start rather than looping abruptly.
                animation: `casino-marquee-text ${Math.max(6, overflow / 14)}s ease-in-out infinite alternate`,
                ["--marquee-shift" as string]: `-${overflow}px`,
              }
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}

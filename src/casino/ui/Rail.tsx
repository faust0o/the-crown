import { cx } from "./cx";

/**
 * A strip of walnut.
 *
 * Structural, not decorative: it is what separates the case from the room, so
 * it runs under the header and over the footer and nowhere else. Wood used as
 * an accent inside the panels would read as trim on trim.
 */
export function Rail({
  groove = false,
  className,
}: {
  /** The routed channel down the middle, as in the reference. */
  groove?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "mat-wood h-2 w-full shrink-0",
        groove && "mat-wood-groove",
        className
      )}
    />
  );
}

import { useState } from "react";
import { proxied } from "./proxied";
import { cx } from "../ui";

/**
 * Coin mark, served by tokens.xyz, set on a square tile.
 *
 * The tile is the foreground mixed a few percent into whatever it sits on, so
 * it reads as a shade off the panel, the inset or the plate alike, in either
 * theme. Most marks are discs with transparent corners; on the tile, every coin
 * takes up the same square whatever shape its mark happens to be.
 *
 * Falls back to the ticker on the same tile, so an unknown or broken logo never
 * reflows the row.
 */
export function CoinIcon({
  ticker,
  src,
  size = 28,
}: {
  ticker: string;
  src?: string | null;
  size?: number;
}) {
  const url = proxied(src);
  // The failed URL rather than a flag: these render in lists that reorder every
  // poll, so React hands one instance a succession of different coins, and a
  // boolean would leave the next one showing letters for a logo it never tried.
  const [failed, setFailed] = useState<string | null>(null);
  // Enough of a margin that a disc doesn't touch the tile's edges, and no more:
  // at 18px every pixel taken from the mark is one it can't spare.
  const pad = Math.max(2, Math.round(size * 0.1));
  const mark = size - pad * 2;

  // Logos live on arweave, IPFS gateways and raw.githubusercontent, which time
  // out often enough to matter — and the proxy answers that with a 502, so
  // without this the row held a blank box where the mark should be.
  const fallback = !url || failed === url;
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid shrink-0 place-items-center bg-foreground/6",
        fallback && "mat-engrave font-semibold text-secondary"
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(2, Math.round(size / 10)),
        fontSize: fallback ? size * 0.34 : undefined,
      }}
    >
      {fallback ? (
        ticker.slice(0, 3)
      ) : (
        <img
          src={url}
          alt=""
          width={mark}
          height={mark}
          loading="lazy"
          onError={() => setFailed(url)}
          className="object-contain"
          style={{ width: mark, height: mark }}
        />
      )}
    </span>
  );
}

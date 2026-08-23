import { useState } from "react";
import { proxied } from "./proxied";

/**
 * Coin mark, served by tokens.xyz. Falls back to a lettered disc of exactly the
 * same size so an unknown or broken logo never reflows the row.
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

  // Logos live on arweave, IPFS gateways and raw.githubusercontent, which time
  // out often enough to matter — and the proxy answers that with a 502, so
  // without this the row held a blank box where the mark should be.
  if (!url || failed === url) return <CoinFallback ticker={ticker} size={size} />;
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(url)}
      className="shrink-0 rounded-[2px] object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function CoinFallback({ ticker, size }: { ticker: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full bg-inset font-semibold text-secondary"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {ticker.slice(0, 3)}
    </span>
  );
}

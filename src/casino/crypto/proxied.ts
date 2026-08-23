/** Route a remote token logo through our own origin (server/src/logo-proxy.ts). */
export function proxied(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith("/") ? src : `/logo?u=${encodeURIComponent(src)}`;
}

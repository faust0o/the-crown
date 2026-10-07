export interface UserView {
  id: string;
  handle: string;
  credits: number;
  /** The wallet this account signs in with. Null only for legacy rows. */
  walletAddress: string | null;
  createdAt: Date;
}

export function toUserView(u: {
  id: string;
  handle: string;
  credits: number;
  walletAddress: string | null;
  createdAt: Date;
}): UserView {
  return {
    id: u.id,
    handle: u.handle,
    credits: u.credits,
    walletAddress: u.walletAddress,
    createdAt: u.createdAt,
  };
}

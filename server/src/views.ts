export interface UserView {
  id: string;
  handle: string;
  credits: number;
  createdAt: Date;
}

export function toUserView(u: {
  id: string;
  handle: string;
  credits: number;
  createdAt: Date;
}): UserView {
  return { id: u.id, handle: u.handle, credits: u.credits, createdAt: u.createdAt };
}

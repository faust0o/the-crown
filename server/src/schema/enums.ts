import { enumType } from "nexus";

export const BetStatus = enumType({
  name: "BetStatus",
  members: ["OPEN", "WON", "LOST", "CASHED_OUT", "VOID"],
});

export const RoundStatus = enumType({
  name: "RoundStatus",
  members: ["OPEN", "LOCKED", "CUT", "SETTLED"],
});

export const RankDirection = enumType({
  name: "RankDirection",
  members: ["HIGHER", "DRAW", "LOWER"],
});

/** Whether an order opened a position or closed one. */
export const OrderKind = enumType({
  name: "OrderKind",
  members: ["BUY", "SELL"],
});

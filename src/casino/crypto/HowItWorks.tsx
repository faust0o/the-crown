import { Dialog } from "../ui";

// Written for someone who has never traded: one idea per step, no jargon.
const STEPS = [
  {
    title: "Ten coins race",
    body: "They're ranked by how much people traded them in the last hour.",
  },
  {
    title: "Pick a coin, call its rank",
    body: "Will it finish the round Higher, Same or Lower than where it started?",
  },
  {
    title: "Long shots pay more",
    body: "The less likely your call, the bigger the payout.",
  },
  {
    title: "The finish is a surprise",
    body: "The round stops at a random moment in its last minute, so nobody can game the ending.",
  },
];

/** Modal explaining the market. */
export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="How The Crown works"
      size="md"
      footer={
        <p className="m-0 text-xs text-muted">
          Credits are play money. Nothing here is a real financial instrument.
        </p>
      }
    >
      <ol className="m-0 list-none space-y-4 p-0">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            {/* The step number is stamped into the case, not printed on it. */}
            <span className="mat-inset mat-engrave mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs text-secondary">
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="mat-engrave block text-sm font-semibold text-foreground">
                {s.title}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-secondary">
                {s.body}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

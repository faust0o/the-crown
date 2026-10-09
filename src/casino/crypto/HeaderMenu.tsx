import { useState } from "react";
import { ROOMY, useMediaQuery } from "../hooks/useMediaQuery";
import { useSession } from "../session/SessionProvider";
import { NEXT_THEME, setPreference, useThemePreference } from "../theme";
import { IconButton, Menu, MenuGroup, MenuItem, Seam, ThemeGlyph } from "../ui";
import { AccountItems } from "./WalletButton";
import { WalletPicker } from "./WalletPicker";

export type Tab = "board" | "portfolio";

const TABS = [
  { value: "board", label: "Board" },
  { value: "portfolio", label: "Portfolio" },
] as const satisfies readonly { value: Tab; label: string }[];

const THEME_NAME = { auto: "Auto", light: "Light", dark: "Dark" } as const;

/**
 * Everything the header has no room for, below the width that fits it all.
 *
 * A wide header carries the previous rounds, the theme key, the account and the
 * help key in a row. On a narrow screen that row wrapped onto three lines of a
 * sticky header — a third of a phone's height spent on chrome before the first
 * coin. The header keeps only what is read constantly (the clock and the
 * balance) and what is the way in (Sign in), and the rest drops from here.
 *
 * On a phone the board/portfolio tabs come in here too: the tabs and the clock
 * and the balance do not share a phone's width, and of the three the tabs are
 * the one used least often.
 */
export function HeaderMenu({
  tab,
  onTab,
  onPreviousRounds,
  onHowItWorks,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  onPreviousRounds: () => void;
  onHowItWorks: () => void;
}) {
  const { user } = useSession();
  const preference = useThemePreference();
  const roomy = useMediaQuery(ROOMY);
  const [picking, setPicking] = useState(false);

  return (
    <>
      <Menu
        trigger={({ open, toggle }) => (
          <IconButton
            variant="key"
            size="md"
            label="Menu"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggle}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none">
              <path
                d="M3.5 6h13M3.5 10h13M3.5 14h13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        )}
      >
        {(close) => (
          <>
            {!roomy && (
              <MenuGroup first>
                {TABS.map((t) => (
                  <MenuItem
                    key={t.value}
                    aria-current={tab === t.value ? "page" : undefined}
                    onClick={() => {
                      onTab(t.value);
                      close();
                    }}
                    className={tab === t.value ? "font-semibold text-foreground" : undefined}
                  >
                    {t.label}
                    {tab === t.value && <Check />}
                  </MenuItem>
                ))}
              </MenuGroup>
            )}

            <MenuGroup first={roomy}>
              <MenuItem
                onClick={() => {
                  close();
                  onPreviousRounds();
                }}
              >
                Previous rounds
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onHowItWorks();
                }}
              >
                How it works
              </MenuItem>
              {/* Stays open when pressed: the point of stepping the theme is
                  watching the page change under the menu. */}
              <MenuItem onClick={() => setPreference(NEXT_THEME[preference])}>
                Theme
                <span className="flex items-center gap-1.5 text-muted">
                  {THEME_NAME[preference]}
                  <ThemeGlyph preference={preference} />
                </span>
              </MenuItem>
            </MenuGroup>

            {user && (
              <>
                <Seam className="mt-3" />
                <div className="mt-3">
                  <AccountItems onClose={close} onConnect={() => setPicking(true)} />
                </div>
              </>
            )}
          </>
        )}
      </Menu>
      <WalletPicker open={picking} onClose={() => setPicking(false)} />
    </>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" fill="none">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

import { useEffect } from "react";
import { PANEL_TITLE } from "@/lib/updates";

const BUBBLE_ATTR = "data-plugin-updates-count";

/**
 * bb doesn't render `experimental_sidebarAccessory` on the icon-only nav rail
 * yet, so decorate our rail entry directly. It's found by bb's
 * `data-nav-rail-item` wrapper and the button's label; if bb changes that
 * markup the bubble just doesn't show.
 */
function findRailItem(): HTMLElement | null {
  for (const item of Array.from(document.querySelectorAll<HTMLElement>("[data-nav-rail-item]"))) {
    const id = item.getAttribute("data-nav-rail-item") ?? "";
    const label = item.querySelector("button")?.getAttribute("aria-label") ?? "";
    if (id.includes("plugin-updates") || label.startsWith(PANEL_TITLE)) return item;
  }
  return null;
}

function paintBubble(count: number) {
  const item = findRailItem();
  const existing = document.querySelector<HTMLElement>(`[${BUBBLE_ATTR}]`);
  if (item === null || count === 0) {
    existing?.remove();
    return;
  }
  const bubble = existing ?? document.createElement("span");
  if (bubble.parentElement !== item) {
    if (getComputedStyle(item).position === "static") item.style.position = "relative";
    bubble.setAttribute(BUBBLE_ATTR, "");
    bubble.setAttribute("aria-hidden", "true");
    bubble.className =
      "pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground";
    item.appendChild(bubble);
  }
  const text = count > 9 ? "9+" : String(count);
  if (bubble.textContent !== text) bubble.textContent = text;
}

/** Keeps the bubble on the rail entry, re-attaching whenever bb re-renders the rail. */
export function useRailBubble(count: number) {
  useEffect(() => {
    paintBubble(count);
    const observer = new MutationObserver(() => paintBubble(count));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelector(`[${BUBBLE_ATTR}]`)?.remove();
    };
  }, [count]);
}

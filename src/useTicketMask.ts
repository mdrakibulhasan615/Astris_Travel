import { useLayoutEffect, type RefObject } from 'react';

/**
 * Feeds the ticket-shape masks in index.css: `--tear-y` is where the seam element starts (the
 * notches go there) and `--pitch` is the scallop spacing, chosen so a whole number of scallops fits
 * the ticket's height. Re-measured whenever the ticket resizes.
 */
export function useTicketMask(
  cardRef: RefObject<HTMLElement | null>,
  seamRef?: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const apply = () => {
      const cardRect = card.getBoundingClientRect();
      const count = Math.max(2, Math.round(cardRect.height / 34));
      card.style.setProperty('--pitch', `${cardRect.height / count}px`);
      const seam = seamRef?.current;
      if (seam) card.style.setProperty('--tear-y', `${seam.getBoundingClientRect().top - cardRect.top}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    return () => observer.disconnect();
  }, [cardRef, seamRef]);
}

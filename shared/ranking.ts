import type { OptionTag, TransitOption } from './types.ts';

/**
 * Ticket ranking and badges for one leg's options.
 *
 * Order, strictly:
 *   1. the best Smart Score (VTTS: price, total duration, stops, time of day… lower is better);
 *   2. the cheapest DIRECT ticket, unless it is already first;
 *   3. the cheapest ticket overall (layovers allowed), unless already placed;
 *   4. everything else, by Smart Score.
 *
 * Badges (a ticket can have several):
 *   `direct`           no stops and no layover
 *   `cheapest-direct`  the lowest-priced direct ticket
 *   `cheapest`         the lowest-priced ticket of all
 * "Priced" means the fare per person.
 */

export const isDirect = (o: Pick<TransitOption, 'stopsCount' | 'layoverHours'>): boolean =>
  o.stopsCount === 0 && o.layoverHours === 0;

/** Lowest net price; ties go to the better Smart Score so the winner is stable. */
function cheapestOf(options: TransitOption[]): TransitOption | undefined {
  let best: TransitOption | undefined;
  for (const o of options) {
    if (
      !best ||
      o.basePriceUsd < best.basePriceUsd ||
      (o.basePriceUsd === best.basePriceUsd && o.smartScore < best.smartScore)
    ) {
      best = o;
    }
  }
  return best;
}

/** Returns the options in ranking order, each with its `tags`. Input is not mutated. */
export function rankAndTag(options: TransitOption[]): TransitOption[] {
  if (options.length === 0) return options;

  const bySmartScore = [...options].sort((a, b) => a.smartScore - b.smartScore);
  const cheapest = cheapestOf(options);
  const cheapestDirect = cheapestOf(options.filter(isDirect));

  const tagsFor = (o: TransitOption): OptionTag[] => {
    const tags: OptionTag[] = [];
    if (o === cheapest) tags.push('cheapest');
    if (o === cheapestDirect) tags.push('cheapest-direct');
    if (isDirect(o)) tags.push('direct');
    return tags;
  };

  const ordered: TransitOption[] = [bySmartScore[0]];
  for (const candidate of [cheapestDirect, cheapest]) {
    if (candidate && !ordered.includes(candidate)) ordered.push(candidate);
  }
  for (const o of bySmartScore) if (!ordered.includes(o)) ordered.push(o);

  return ordered.map((o) => ({ ...o, tags: tagsFor(o) }));
}

import { Gauge } from 'lucide-react';

interface SmartScoreBadgeProps {
  score: number;
  /** `md` for the option a card is about, `sm` inside dense summary rows. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The VTTS Smart Score, shown the same way on every transport and stay card. Lower is better:
 * it is the price plus the traveller's time and comfort costs, all in USD.
 */
export function SmartScoreBadge({ score, size = 'md', className = '' }: SmartScoreBadgeProps) {
  return (
    <span
      title="VTTS Smart Score: price plus the cost of your time and comfort. Lower is better."
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-[#FFD6BA] bg-[#FFF4ED] font-mono font-semibold text-[#E56B1A] tabular-nums ${
        size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-px text-[11px]'
      } ${className}`}
    >
      <Gauge className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} aria-hidden="true" />
      <span className="font-sans font-medium">Smart Score</span>
      <span>{Number.isFinite(score) ? score.toFixed(0) : '–'}</span>
    </span>
  );
}

import { useState, type FormEvent } from 'react';
import { Check, Tag, Ticket, X } from 'lucide-react';
import { calculateVoucherDiscount } from '../../shared/smartScore.ts';
import { useCurrency } from '../currency.tsx';
import type { TripLeg, Voucher, VoucherValidationResult } from '../../shared/types.ts';

interface VoucherDrawerProps {
  isOpen: boolean;
  vouchers: Voucher[];
  appliedCodes: string[];
  legs: TripLeg[];
  onClose: () => void;
  onToggleVoucher: (code: string) => void;
  onValidateCode: (code: string) => Promise<VoucherValidationResult>;
}

export function VoucherDrawer({
  isOpen,
  vouchers,
  appliedCodes,
  legs,
  onClose,
  onToggleVoucher,
  onValidateCode,
}: VoucherDrawerProps) {
  const { fmt } = useCurrency();
  const [inputCode, setInputCode] = useState('');
  const [feedback, setFeedback] = useState<VoucherValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputCode.trim()) return;
    setIsValidating(true);
    try {
      const res = await onValidateCode(inputCode.trim());
      setFeedback(res);
      if (res.valid && res.voucher && !appliedCodes.includes(res.voucher.code)) {
        onToggleVoucher(res.voucher.code);
        setInputCode('');
      }
    } finally {
      setIsValidating(false);
    }
  };

  const getVoucherPotentialSavings = (voucher: Voucher) => {
    let total = 0;
    for (const leg of legs) {
      const selected =
        leg.transitOptions.find((o) => o.id === leg.selectedOptionId) ??
        leg.transitOptions[0];
      if (selected) {
        total += calculateVoucherDiscount(selected, voucher);
      }
    }
    return total;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voucher and promo matcher"
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-xs"
    >
      <div className="w-full max-w-md bg-white h-full border-l border-neutral-200 shadow-2xl flex flex-col">
        <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#FFF4ED] border border-[#FFD6BA] text-[#E56B1A] flex items-center justify-center">
              <Ticket className="w-4 h-4" />
            </span>
            <h2 className="font-display text-lg font-bold text-[#111827]">
              Vouchers
            </h2>
          </div>

          <button
            type="button"
            aria-label="Close vouchers panel"
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#4B5563] hover:text-[#111827] hover:bg-neutral-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 flex-1 overflow-y-auto astris-scroll">
          <form onSubmit={handleSubmit} className="space-y-2">
            <label htmlFor="promo-code-input" className="block text-xs font-semibold text-[#111827]">
              Promo Code
            </label>
            <div className="flex gap-2">
              <input
                id="promo-code-input"
                type="text"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                placeholder="ISTHUB40"
                className="flex-1 px-3.5 py-2.5 rounded-xl border border-neutral-200 font-mono text-sm text-[#111827] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#FF812E]"
              />
              <button
                type="submit"
                disabled={isValidating}
                className="px-4 py-2.5 rounded-xl bg-[#FF812E] hover:bg-[#E56B1A] text-white text-sm font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-60"
              >
                {isValidating ? 'Checking...' : 'Apply'}
              </button>
            </div>

            {feedback && (
              <p
                className={`text-xs ${
                  feedback.valid ? 'text-[#16A34A]' : 'text-[#DC2626]'
                }`}
              >
                {feedback.reason}
              </p>
            )}
          </form>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[#111827]">
              Partner Vouchers
            </h3>

            {vouchers.map((voucher) => {
              const isApplied = appliedCodes.includes(voucher.code);
              const potentialSavings = getVoucherPotentialSavings(voucher);

              return (
                <div
                  key={voucher.id}
                  className={`rounded-2xl p-4 border transition-all ${
                    isApplied
                      ? 'bg-[#FFF4ED] border-[#FFD6BA]'
                      : 'bg-white border-neutral-200/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Tag className="w-3.5 h-3.5 text-[#E56B1A]" />
                        <span className="font-mono text-sm font-bold text-[#111827]">
                          {voucher.code}
                        </span>
                        {potentialSavings > 0 && (
                          <span className="text-xs font-semibold text-[#16A34A] font-mono tabular-nums">
                            -{fmt(potentialSavings)}
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-semibold text-[#111827]">
                        {voucher.title}
                      </div>
                      <div className="text-[11px] text-[#4B5563] font-mono pt-0.5 tabular-nums">
                        {voucher.applicableModes.join(' / ')} · Min {fmt(voucher.minSpendUsd)} · Exp{' '}
                        {voucher.expiresAt}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onToggleVoucher(voucher.code)}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 transition-colors cursor-pointer ${
                        isApplied
                          ? 'bg-[#111827] text-white hover:bg-neutral-800'
                          : 'bg-[#FF812E] hover:bg-[#E56B1A] text-white'
                      }`}
                    >
                      {isApplied && <Check className="w-3.5 h-3.5" />}
                      <span>{isApplied ? 'Active' : 'Activate'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

type Outcome = 'success' | 'failed' | 'abandoned';

interface BookingStatus {
  status: 'pending' | 'issued';
  bookingReference?: string;
}

/**
 * Where Duffel's hosted checkout sends the traveller back to (`/?booking=success&ref=…`). Shows what
 * happened and, once Duffel's webhook has recorded the ticket, the airline's booking reference.
 */
export function BookingBanner() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [status, setStatus] = useState<BookingStatus | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('booking');
    const ref = params.get('ref');
    // Duffel adds the order id to the success redirect
    const orderId = params.get('order_id');
    if (state !== 'success' && state !== 'failed' && state !== 'abandoned') return;
    setOutcome(state);
    // Keep the address bar clean so a reload does not show the banner again
    window.history.replaceState(null, '', window.location.pathname);
    if (state !== 'success' || !ref) return;

    // The webhook may land a moment after the redirect: look a few times
    let attempts = 0;
    let timer = 0;
    const look = async () => {
      attempts++;
      try {
        const res = await fetch(
          `/api/flights/orders/${encodeURIComponent(ref)}${orderId ? `?order_id=${encodeURIComponent(orderId)}` : ''}`
        );
        if (res.ok) {
          const data = (await res.json()) as BookingStatus;
          setStatus(data);
          if (data.status === 'issued') return;
        }
      } catch {
        /* the banner still reads fine without the lookup */
      }
      if (attempts < 6) timer = window.setTimeout(look, 4000);
    };
    void look();
    return () => window.clearTimeout(timer);
  }, []);

  if (!outcome) return null;

  const view =
    outcome === 'success'
      ? {
          Icon: CheckCircle2,
          tone: 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]',
          text:
            status?.status === 'issued'
              ? `Booking confirmed${status.bookingReference ? `. Airline reference ${status.bookingReference}` : ''}. Your tickets are on their way by email.`
              : 'Payment received. Your ticket is being issued; the confirmation arrives by email.',
        }
      : outcome === 'failed'
        ? {
            Icon: XCircle,
            tone: 'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]',
            text: 'The booking did not go through and you have not been charged. Pick a fare and try again.',
          }
        : {
            Icon: Info,
            tone: 'border-[#E5E7EB] bg-white text-[#374151]',
            text: 'Checkout closed without booking. Your trip is saved here whenever you want to continue.',
          };

  return (
    <div role="status" className={`flex items-start gap-2.5 border-b px-5 py-2.5 text-xs font-medium ${view.tone}`}>
      <view.Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{view.text}</span>
      <button
        type="button"
        onClick={() => setOutcome(null)}
        aria-label="Dismiss"
        className="cursor-pointer rounded p-0.5 hover:bg-black/5"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

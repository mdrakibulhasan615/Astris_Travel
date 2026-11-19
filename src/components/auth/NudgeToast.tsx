import { createPortal } from 'react-dom';
import { Smartphone, X } from 'lucide-react';

/** Compact, non-blocking bottom-right card (Trigger C). Never covers the page; × snoozes it. */
export function NudgeToast({ onLogin, onClose }: { onLogin: () => void; onClose: () => void }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="astris-nudge fixed bottom-4 right-4 z-[80] flex w-[calc(100vw-2rem)] max-w-xs items-start gap-3 rounded-2xl glass-dark p-4 text-white"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#EA580C]/15 text-[#EA580C]">
        <Smartphone className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-white/80">Want to access this route on your phone?</p>
        <button
          type="button"
          onClick={onLogin}
          className="mt-1 cursor-pointer font-bold text-[#FB923C] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C] rounded"
        >
          Log in to save route
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded-full p-1 text-white/55 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>,
    document.body
  );
}

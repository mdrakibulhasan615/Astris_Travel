import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Mail, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';

/** Login modal (dark #111827 / burnt orange #EA580C), used by every login prompt. */

export type AuthModalVariant = 'checkout' | 'exit' | 'nudge' | 'manual';

const COPY: Record<AuthModalVariant, { title: string; body: string; dismiss: string }> = {
  checkout: {
    title: 'Save your trip itinerary & track this flight?',
    body: 'Your seller opened in a new tab. Log in to keep this route and pick it up on any device.',
    dismiss: 'Continue as Guest',
  },
  exit: {
    title: 'Leaving already? Log in to save your current route across devices',
    body: 'Your route is saved in this browser. Log in to open it on your phone or laptop too.',
    dismiss: 'No thanks, close',
  },
  nudge: {
    title: 'Log in to save route',
    body: 'Keep this route in your account and open it on your phone anytime. Free, no password.',
    dismiss: 'Not now',
  },
  manual: {
    title: 'Log in to Astris Travel',
    body: 'Save routes to your account and open them on any device. Free, no password.',
    dismiss: 'Continue as Guest',
  },
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function AuthModal({
  variant,
  onClose,
  onLoginStarted,
}: {
  variant: AuthModalVariant;
  onClose: () => void;
  onLoginStarted: () => void;
}) {
  const { loginWithGoogle, sendMagicLink, verifyCode } = useAuth();
  const copy = COPY[variant];
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'start' | 'sent'>('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Keep Tab inside the dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const items = dialogRef.current.querySelectorAll<HTMLElement>('button, input, a[href]');
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSendLink = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendMagicLink(email.trim());
    setBusy(false);
    if (r.ok) {
      onLoginStarted();
      setStep('sent');
    } else setError(r.message);
  };

  const onVerify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await verifyCode(email.trim(), code.trim());
    setBusy(false);
    if (!r.ok) setError(r.message);
    // On success the provider closes the modal (the user is no longer a guest)
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="relative w-full max-w-md rounded-t-3xl border border-white/10 bg-[#111827] p-6 text-white shadow-2xl sm:rounded-3xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 cursor-pointer rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-1 h-1 w-10 rounded-full bg-[#EA580C]" aria-hidden="true" />
        <h2 id="auth-modal-title" className="mt-3 pr-8 font-display text-xl font-bold leading-snug">
          {copy.title}
        </h2>
        <p className="mt-2 text-sm text-white/70">{copy.body}</p>

        {step === 'start' ? (
          <div className="mt-5 space-y-3">
            <button
              ref={firstRef}
              type="button"
              onClick={() => {
                onLoginStarted();
                loginWithGoogle();
              }}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#111827] hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#111827]"
            >
              <GoogleMark /> Continue with Google
            </button>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-white/40">
              <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
            </div>
            <form onSubmit={onSendLink} className="flex gap-2">
              <label htmlFor="auth-email" className="sr-only">
                Email address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-[#EA580C] focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-[#EA580C] px-3.5 py-2.5 text-sm font-semibold text-white hover:bg-[#C2410C] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Mail className="h-4 w-4" /> {busy ? 'Sending…' : 'Email link'}
              </button>
            </form>
          </div>
        ) : (
          <form onSubmit={onVerify} className="mt-5 space-y-3">
            <p className="rounded-xl bg-white/5 px-3 py-2.5 text-sm text-white/80">
              Check <span className="font-semibold text-white">{email}</span>. Open the link on this device, or type the code from the email here.
            </p>
            <div className="flex gap-2">
              <label htmlFor="auth-code" className="sr-only">
                Code from the email
              </label>
              <input
                id="auth-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,10}"
                maxLength={10}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 font-mono text-sm tracking-widest text-white placeholder:text-white/35 focus:border-[#EA580C] focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || code.length < 6}
                className="shrink-0 cursor-pointer rounded-xl bg-[#EA580C] px-3.5 py-2.5 text-sm font-semibold text-white hover:bg-[#C2410C] disabled:opacity-60"
              >
                {busy ? 'Checking…' : 'Verify'}
              </button>
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-[#FDBA74]">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full cursor-pointer rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold text-white/85 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C]"
        >
          {copy.dismiss}
        </button>
      </div>
    </div>,
    document.body
  );
}

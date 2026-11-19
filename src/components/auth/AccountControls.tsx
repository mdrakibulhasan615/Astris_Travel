import { useEffect, useRef, useState } from 'react';
import { Check, Cloud, CloudOff, Link2, LogOut, UserRound } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useAuthPrompt } from '../../context/AuthPromptContext.tsx';
import type { SyncStatus } from '../../useRouteStorage.ts';

/** Top-bar controls: "Copy route sync link" (works for guests too) and Log in / the account menu. */
export function AccountControls({
  hasRoute,
  syncStatus,
  onCopyLink,
}: {
  hasRoute: boolean;
  syncStatus: SyncStatus;
  onCopyLink: () => Promise<string | null>;
}) {
  const { ready, configured, user, logout } = useAuth();
  const { openLogin } = useAuthPrompt();
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const copy = async () => {
    if (await onCopyLink()) setCopied(true);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        disabled={!hasRoute}
        title={hasRoute ? 'Copy a link that opens this route on any device' : 'Add a destination first'}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl glass-control px-2.5 text-sm font-semibold text-[#111827] hover:border-[#FFD6BA] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
      >
        {copied ? <Check className="h-4 w-4 text-[#15803D]" /> : <Link2 className="h-4 w-4 text-[#EA580C]" />}
        <span className="hidden xl:inline">{copied ? 'Link copied' : 'Copy route sync link'}</span>
        <span className="sr-only xl:hidden">{copied ? 'Link copied' : 'Copy route sync link'}</span>
      </button>

      {ready && configured && !user && (
        <button
          type="button"
          onClick={openLogin}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl bg-[#111827] px-3 text-sm font-semibold text-white hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EA580C] focus-visible:ring-offset-2"
        >
          <UserRound className="h-4 w-4" />
          <span className="hidden sm:inline">Log in</span>
        </button>
      )}

      {user && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={syncStatus === 'error' ? 'Sync failed: your route is still saved on this device' : 'Route synced to your account'}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl glass-control pl-1 pr-2.5 text-sm font-semibold text-[#111827] hover:border-[#FFD6BA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF812E]"
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-7 w-7 rounded-lg object-cover" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#EA580C] text-xs font-bold text-white">
                {(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}
              </span>
            )}
            {syncStatus === 'error' ? (
              <CloudOff className="h-4 w-4 text-[#B91C1C]" />
            ) : (
              <Cloud className={`h-4 w-4 ${syncStatus === 'syncing' ? 'animate-pulse text-[#9CA3AF]' : 'text-[#15803D]'}`} />
            )}
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-11 z-50 w-60 rounded-2xl glass-strong p-2">
              <p className="truncate px-2 py-1.5 text-xs text-[#6B7280]">{user.email ?? user.name}</p>
              <p className="px-2 pb-2 text-xs text-[#4B5563]">
                {syncStatus === 'error' ? 'Sync failed; saved on this device.' : syncStatus === 'syncing' ? 'Syncing…' : 'Routes synced to your account.'}
              </p>
              <button
                type="button"
                role="menuitem"
                onClick={async () => {
                  setMenuOpen(false);
                  await logout();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm font-semibold text-[#111827] hover:bg-white/70"
              >
                <LogOut className="h-4 w-4" /> Log out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, type ReactNode } from 'react';

/**
 * An externally hosted brand logo that falls back to `fallback` (a drawn badge) when it cannot be
 * shown. No referrer is sent, so the logo hosts learn nothing about the page the traveller is on.
 */
export function BrandLogo({
  src,
  alt,
  fallback,
  className,
}: {
  src?: string;
  alt: string;
  fallback: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

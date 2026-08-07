/** Aperture / lens mark — used in header, hero, empty states. */
export function BrandMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  // Unique gradient id per instance (multiple marks on one page)
  const gid = `lens-${size}-${className.length}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle
        cx="16"
        cy="16"
        r="14.5"
        stroke={`url(#${gid})`}
        strokeWidth="1.5"
      />
      <circle
        cx="16"
        cy="16"
        r="9"
        stroke="#7c6cff"
        strokeWidth="1.25"
        opacity="0.9"
      />
      <circle cx="16" cy="16" r="3.5" fill="#2dd4bf" />
      <path
        d="M16 2.5 L19.2 9.5 L16 8.2 L12.8 9.5 Z"
        fill="#a78bfa"
        opacity="0.85"
      />
      <defs>
        <linearGradient id={gid} x1="4" y1="4" x2="28" y2="28">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#2dd4bf" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function BookGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden
    >
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
      <path d="M8 7h6M8 11h6" strokeLinecap="round" />
    </svg>
  );
}

export function ClaimGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden
    >
      <path
        d="M5 7h14M5 12h10M5 17h12"
        strokeLinecap="round"
      />
      <circle cx="18.5" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ConceptGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="8" r="3" />
      <circle cx="6.5" cy="16" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
      <path d="M10 10.5 8 14M14 10.5l2 3.5" strokeLinecap="round" />
    </svg>
  );
}

export function EdgeGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M8.2 11 15.5 8M8.2 13l7.3 3" strokeLinecap="round" />
    </svg>
  );
}

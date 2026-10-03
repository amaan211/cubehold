/**
 * The cubehold mark: a white isometric cube on a green rounded square, the
 * same drawing as packaging/assets/icon.svg. Fixed colors: a logo looks the
 * same in light and dark themes.
 */
export function Logo({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      <rect width="64" height="64" rx="16" fill="#00924a" />
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M32 11.5 49.8 21.9v20.2L32 52.5 14.2 42.1V21.9Z" />
        <path d="M14.2 21.9 32 32.3l17.8-10.4M32 32.3v20.2" />
      </g>
    </svg>
  );
}

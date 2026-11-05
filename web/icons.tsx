import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './ui/Tooltip';

const paths = {
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 2-3-2-2 1-3-3-2-1-3Z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  sequence: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V10a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </>
  ),
  contracts: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </>
  ),
  tests: (
    <>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  check: <path d="M20 6 9 17l-5-5" />,
  circleCheck: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  circleDashed: <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />,
  circleSlash: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m6 18 12-12" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  send: <path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />,
  laptop: (
    <>
      <rect x="4" y="3" width="16" height="13" rx="2" />
      <path d="m4 16-2 4h20l-2-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" />
      <path d="M3 2v4M1 4h4M20 18v4M18 20h4" />
    </>
  ),
  wand: (
    <>
      <path d="m15 4 5 5L8.5 20.5a1.5 1.5 0 0 1-2 0l-3-3a1.5 1.5 0 0 1 0-2z" />
      <path d="m12.5 6.5 5 5M19 2v3M17.5 3.5h3M5 3v2M4 4h2" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  // GitHub's diff expanders: an arrow towards the hidden code over a dotted edge.
  foldUp: <path d="M12 15V4M7 9l5-5 5 5M4 20h1M9.5 20h1M13.5 20h1M19 20h1" />,
  foldDown: <path d="M12 9v11M7 15l5 5 5-5M4 4h1M9.5 4h1M13.5 4h1M19 4h1" />,
  unfold: <path d="M12 3v6M9 6l3-3 3 3M12 21v-6M9 18l3 3 3-3M4 12h1M9.5 12h1M13.5 12h1M19 12h1" />,
  arrowLeft: <path d="M19 12H5M12 19l-7-7 7-7" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  alert: (
    <>
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  externalLink: (
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <path d="M6 7.5v9M18 9.5a6 6 0 0 1-6 6H8" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/** A square icon action; the label is both its accessible name and its tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: IconName;
    label: string;
    /** Close buttons and similar obvious actions need no tooltip. */
    tooltip?: boolean;
    children?: ReactNode;
  }
>(function IconButton({ icon, label, tooltip = true, className, children, ...props }, ref) {
  const button = (
    <button
      ref={ref}
      type="button"
      {...props}
      className={`icon-button${className ? ` ${className}` : ''}`}
      aria-label={label}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
  return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button;
});

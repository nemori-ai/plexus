/** Inline icons — small, stroke-based, sized via currentColor. No icon library. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const IconKey = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7.5" cy="15.5" r="4" />
    <path d="M10.3 12.7 20 3m-3 0 3 3m-6 0 2 2" />
  </svg>
);

export const IconPlug = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 2v6m6-6v6M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p)} className={`check ${p.className ?? ""}`}>
    <path d="m4 12 5 5L20 6" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
  </svg>
);

export const IconToken = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="7" width="18" height="10" rx="2" />
    <path d="M7 12h.01M11 12h2" />
  </svg>
);

export const IconScroll = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 4h10v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7m4-3a3 3 0 0 0-3 3m3-3a3 3 0 0 1 3 3v0M8 9h6M8 13h6" />
  </svg>
);

export const IconInbox = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 13h4l2 3h4l2-3h4M4 13l2-7h12l2 7v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" />
  </svg>
);

export const IconGrants = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    <path d="m9 11 2 2 4-4" />
  </svg>
);

export const IconSource = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="5" rx="7" ry="3" />
    <path d="M5 5v6c0 1.66 3.13 3 7 3s7-1.34 7-3V5M5 11v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
  </svg>
);

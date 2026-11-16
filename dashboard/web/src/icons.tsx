// Inline icons (no icon fonts or CDNs). 20x20, stroke = currentColor.
import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  overview: <><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="4" rx="1.5" /><rect x="11" y="9" width="6" height="8" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /></>,
  sort: <><path d="M4 5h12M4 10h8M4 15h4" /><path d="M15 9v7m0 0-2.5-2.5M15 16l2.5-2.5" /></>,
  group: <><rect x="3" y="5" width="9" height="9" rx="1.5" /><path d="M8 3h7.5A1.5 1.5 0 0 1 17 4.5V12" /><circle cx="6.5" cy="9" r="1.2" /><path d="m3.5 13 3-3 2.5 2.5 1-1 2 2" /></>,
  search: <><circle cx="9" cy="9" r="5" /><path d="m13 13 4 4" /></>,
  faces: <><circle cx="10" cy="7.5" r="3.2" /><path d="M4 17c.8-3.2 3.2-5 6-5s5.2 1.8 6 5" /></>,
  runs: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></>,
  cluster: <><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="12" y="3" width="5" height="5" rx="1" /><rect x="7.5" y="12" width="5" height="5" rx="1" /><path d="M5.5 8v1.5h9V8M10 9.5V12" /></>,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" /></>,
  privacy: <><path d="M10 2.5 4 5v4.5c0 3.8 2.6 6.9 6 8 3.4-1.1 6-4.2 6-8V5z" /><path d="m7.5 10 1.8 1.8 3.4-3.6" /></>,
  shield: <><path d="M10 2.5 4 5v4.5c0 3.8 2.6 6.9 6 8 3.4-1.1 6-4.2 6-8V5z" /></>,
  blur: <><circle cx="10" cy="10" r="6.5" strokeDasharray="2 2" /><circle cx="10" cy="10" r="2.5" /></>,
  folder: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" /></>,
  up: <><path d="M10 16V5m0 0-4 4m4-4 4 4" /></>,
  copy: <><rect x="7" y="7" width="9" height="9" rx="1.5" /><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" /></>,
  stop: <><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></>,
  undo: <><path d="M7 5 3.5 8.5 7 12" /><path d="M3.5 8.5h8a4.5 4.5 0 0 1 0 9H9" /></>,
  play: <><path d="M6.5 4.5v11l9-5.5z" /></>,
  x: <><path d="m5 5 10 10M15 5 5 15" /></>,
  chevron: <><path d="m8 5 5 5-5 5" /></>,
  video: <><rect x="2.5" y="5" width="11" height="10" rx="1.5" /><path d="m13.5 9 4-2.5v7l-4-2.5" /></>,
  image: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><circle cx="7.5" cy="8.5" r="1.3" /><path d="m3.5 14.5 4-4 3 3 2-2 4 4" /></>,
  cloud: <><path d="M6 15.5h8.5a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 5.3 9 3.3 3.3 0 0 0 6 15.5z" /></>,
  refresh: <><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M16.5 3.5V7H13" /></>,
  frames: <><rect x="2.5" y="6" width="15" height="8" rx="1" /><path d="M7.5 6v8M12.5 6v8" /></>,
  similar: <><path d="M10 3v3.5M10 13.5V17M3 10h3.5M13.5 10H17M5.6 5.6l2 2M12.4 12.4l2 2M14.4 5.6l-2 2M7.6 12.4l-2 2" /></>,
  alert: <><path d="M10 3 2.5 16.5h15z" /><path d="M10 8.5V12M10 14.5v.01" /></>,
  browse: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></>,
  index: <><ellipse cx="10" cy="5" rx="6" ry="2.5" /><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" /></>,
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] ?? null}
    </svg>
  );
}

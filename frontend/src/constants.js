// ─── Z-Index Layers ────────────────────────────────────────────────────────
/** Stacking order for overlapping UI surfaces. Keep modals above panels above nav. */
export const Z = {
  DROPDOWN:       10,
  MODAL_BACKDROP: 100,
  SIDE_BACKDROP:  149,
  SIDE_PANEL:     150,
  BOTTOM_NAV:     200,
  MODAL:          300,
};

// ─── Breakpoints ───────────────────────────────────────────────────────────
/** Pixel breakpoints for responsive JS logic (tailwind handles CSS side). */
export const BP = {
  MOBILE: 768,
};

// ─── Design Tokens ─────────────────────────────────────────────────────────
/** Color tokens — mirrors CSS variables and tailwind theme.extend.colors. */
export const COLOR = {
  // Text
  TEXT_PRIMARY:   "rgba(235,235,245,0.92)",
  TEXT_SECONDARY: "rgba(235,235,245,0.80)",
  TEXT_MUTED:     "rgba(235,235,245,0.50)",
  TEXT_FAINT:     "rgba(235,235,245,0.30)",
  TEXT_DISABLED:  "rgba(235,235,245,0.40)",

  // Accents
  ACCENT_RED:     "#FF375F",
  ACCENT_GREEN:   "#30d158",
  ACCENT_ORANGE:  "#FF9F0A",
  ACCENT_BLUE:    "#0a84ff",

  // Surfaces
  SURFACE:        "rgba(28,28,30,1)",
  SURFACE_HOVER:  "rgba(44,44,46,1)",
  BG_BASE:        "#000000",
  BG_NAV:         "rgba(10,10,12,0.96)",

  // Borders
  BORDER_SUBTLE:  "rgba(255,255,255,0.08)",
  BORDER_MEDIUM:  "rgba(255,255,255,0.12)",
};

/** Spacing scale (px). Aligns with tailwind 4px base — use for inline styles only. */
export const SPACING = {
  XS:  4,
  SM:  8,
  MD:  12,
  LG:  16,
  XL:  24,
  XXL: 32,
};

/** Border-radius scale (px). Mirrors tailwind theme.extend.borderRadius. */
export const RADIUS = {
  SM:  4,
  MD:  6,
  LG:  10,
  XL:  14,
  XXL: 20,
};

/** Easing curves. Mirrors tailwind transitionTimingFunction tokens. */
export const EASING = {
  SPRING: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  SNAPPY: "cubic-bezier(0.4, 0, 0.2, 1)",
};

// ─── Service config (colors + LAN URLs) ───────────────────────────────────
// Derive the LAN host from the browser location so service links work on any server
const LAN_HOST = typeof window !== "undefined" ? window.location.hostname : "localhost";

/** Per-service gradients, LAN URLs, and short labels for the dashboard tiles. */
export const SERVICES = {
  sonarr:      { gradient: ["#3498db", "#1a5f8a"], url: `http://${LAN_HOST}:8989`, label: "TV"     },
  radarr:      { gradient: ["#e8b34b", "#a07820"], url: `http://${LAN_HOST}:7878`, label: "Movie"  },
  lidarr:      { gradient: ["#9b59b6", "#5d2887"], url: `http://${LAN_HOST}:8686`, label: "Music"  },
  qbittorrent: { gradient: ["#27ae60", "#145a32"], url: `http://${LAN_HOST}:8080`, label: null     },
  jellyfin:    { gradient: ["#00b4d8", "#0077b6"], url: `http://${LAN_HOST}:8096`, label: null     },
  navidrome:   { gradient: ["#e84393", "#a01a5f"], url: `http://${LAN_HOST}:4533`, label: null     },
  prowlarr:    { gradient: ["#e74c3c", "#7b1a1a"], url: `http://${LAN_HOST}:9696`, label: null     },
  bazarr:      { gradient: ["#f39c12", "#8b6914"], url: `http://${LAN_HOST}:6767`, label: null     },
  slskd:       { gradient: ["#8e44ad", "#5b2870"], url: `http://${LAN_HOST}:5030`, label: null     },
  obsidian:    { gradient: ["#7c3aed", "#4c1d95"], url: null,                      label: null     },
  flaresolverr:{ gradient: ["#ef4444", "#991b1b"], url: null,                      label: null     },
  couchdb:     { gradient: ["#d97706", "#92400e"], url: null,                      label: null     },
};

/** Fallback gradient for unknown services. */
export const SERVICE_DEFAULT_GRADIENT = ["#636e72", "#2d3436"];

/** Returns [color1, color2] gradient for a service name string. */
export function getServiceGradient(name) {
  const key = (name || "").toLowerCase().replace(/[^a-z]/g, "");
  for (const [svc, cfg] of Object.entries(SERVICES)) {
    if (key.includes(svc)) return cfg.gradient;
  }
  return SERVICE_DEFAULT_GRADIENT;
}

/** Returns the LAN URL for a service name string, or null. */
export function getServiceUrl(name) {
  const key = (name || "").toLowerCase().replace(/[^a-z]/g, "");
  for (const [svc, cfg] of Object.entries(SERVICES)) {
    if (key.includes(svc) && cfg.url) return cfg.url;
  }
  return null;
}

/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  plugins: [
    // Tailwind resolves these CommonJS plugins even though this package is ESM.
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
  theme: {
    extend: {
      colors: {
        "bg-base":       "var(--bg-base)",
        "bg-card":       "var(--surface)",
        "bg-card-hover": "var(--surface-hover)",
        "bg-surface":    "var(--surface)",
        "bg-surface-2":  "var(--surface-hover)",
        "bg-hover":      "var(--surface-hover)",
        "border-subtle": "var(--border-subtle)",
        "border-medium": "var(--border-medium)",
        "text-primary":  "var(--text-primary)",
        "text-secondary":"var(--text-secondary)",
        "text-muted":    "var(--text-muted)",
        "accent-green":  "#30d158",
        "accent-red":    "#ff375f",
        "accent-orange": "#ff9f0a",
        "accent-blue":   "#0a84ff",
        "accent-purple": "#bf5af2",
      },
      borderRadius: {
        // Coherent scale; keep tailwind defaults working, add token-aligned steps
        "sm":  "4px",
        "md":  "6px",
        "lg":  "10px",
        "xl":  "14px",
        "2xl": "20px",
      },
      boxShadow: {
        // Subtle, layered elevation tokens used across cards / modals / panels
        "subtle":   "0 1px 2px rgba(0,0,0,0.20)",
        "elevated": "0 4px 12px rgba(0,0,0,0.32)",
        "panel":    "0 12px 40px rgba(0,0,0,0.45)",
        "modal":    "0 24px 64px rgba(0,0,0,0.55)",
        "glow-blue":"0 0 0 1px rgba(10,132,255,0.30), 0 4px 16px rgba(10,132,255,0.25)",
      },
      transitionTimingFunction: {
        // Spring-like easing for satisfying micro-interactions: use as `ease-spring`
        "spring": "cubic-bezier(0.22, 0.61, 0.36, 1)",
        "snappy": "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      fontFamily: {
        "display": ["Inter", "-apple-system", "BlinkMacSystemFont", "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        "mono": ["JetBrains Mono", "monospace"],
      },
    },
  },
};

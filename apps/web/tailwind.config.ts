import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: v("paper"),
        surface: v("surface"),
        ink: v("ink"),
        "ink-2": v("ink-2"),
        muted: v("muted"),
        faint: v("faint"),
        line: v("line"),
        accent: v("accent"),
        "accent-hover": v("accent-hover"),
        "on-accent": v("on-accent"),
        danger: v("danger"),
        ok: v("ok"),
        warn: v("warn"),
        // The four actors of "agents collect, code computes, humans decide, chain proves".
        ai: v("ai"),
        code: v("code"),
        human: v("human"),
        chain: v("chain"),
        mock: v("mock"),
        bar: v("bar"),
        shadow: v("shadow"),
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;

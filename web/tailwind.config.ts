import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--ink) / <alpha-value>)",
        marble: "rgb(var(--marble) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        // the grays, tinted a touch cool so black surfaces read as graphite, not soot
        zinc: {
          50: "#f6f7f9",
          100: "#eceef2",
          200: "#d6dae2",
          300: "#b3b9c6",
          400: "#8b93a3",
          500: "#6b7383",
          600: "#4d5462",
          700: "#363c48",
          800: "#23272f",
          900: "#15181e",
          950: "#0b0d11",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-instrument-serif)", "Georgia", "serif"],
      },
      boxShadow: {
        glow: "0 0 60px -10px rgba(var(--accent), 0.35)",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
export default config;

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef7ff",
          100: "#d9ecff",
          200: "#bcdfff",
          300: "#8eccff",
          400: "#58adff",
          500: "#3189fc",
          600: "#1a6bf0",
          700: "#1354de",
          800: "#1644b4",
          900: "#173c8e",
        },
        market: {
          green: "#10b981",
          greenMuted: "rgba(16, 185, 129, 0.15)",
          red: "#f43f5e",
          redMuted: "rgba(244, 63, 94, 0.15)",
          gold: "#f59e0b",
          cyan: "#06b6d4",
          purple: "#8b5cf6",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;

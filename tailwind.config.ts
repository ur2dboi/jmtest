import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        card: '#111111',
        card2: '#1a1a1a',
        line: '#333333',
        muted: '#a1a1aa',
        gold: '#F5E121',
        goldsoft: '#F9E29C',
        blue: '#3b82f6',
        bluedark: '#1d4ed8',
        ma: '#d97706',
        ca: '#2563eb',
        ok: '#10b981',
        bad: '#ef4444',
        warn: '#fbbf24',
        violet: '#8b5cf6',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      keyframes: {
        fadeIn: { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulseSlot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
      },
      animation: {
        fadeIn: 'fadeIn .3s ease',
        pulseSlot: 'pulseSlot 2s infinite',
      },
    },
  },
  plugins: [],
};

export default config;

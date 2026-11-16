import { heroui } from '@heroui/theme';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/layouts/**/*.{js,ts,jsx,tsx,mdx}',
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
  ],
  safelist: [
    {
      pattern:
        /bg-(primary|secondary|success|danger|warning|default)-(50|100|200|300|400|500|600|700|800|900)/,
    },
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'JetBrains Mono',
          'monospace',
        ],
      },
    },
  },
  darkMode: 'class',
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            primary: {
              DEFAULT: '#2964e5',
              foreground: '#fff',
              50: '#edf3ff',
              100: '#dce8ff',
              200: '#b9cfff',
              300: '#8aafff',
              400: '#5989f3',
              500: '#2964e5',
              600: '#2051c0',
              700: '#1e4198',
              800: '#1d3778',
              900: '#172a58',
            },
            secondary: {
              DEFAULT: '#88C0D0', // 冰霜蓝
              foreground: '#fff',
              50: '#F0F9FC',
              100: '#D7F0F8',
              200: '#AEE1F2',
              300: '#88C0D0',
              400: '#5E9FBF',
              500: '#4C8DAE',
              600: '#3A708C',
              700: '#2A546A',
              800: '#1A3748',
              900: '#0B1B26',
            },
            danger: {
              DEFAULT: '#DB3694',
              foreground: '#fff',
              50: '#FEEAF6',
              100: '#FDD7DD',
              200: '#FBAFC4',
              300: '#F485AE',
              400: '#E965A3',
              500: '#DB3694',
              600: '#BC278B',
              700: '#9D1B7F',
              800: '#7F1170',
              900: '#690A66',
            },
          },
        },
        dark: {
          colors: {
            primary: {
              DEFAULT: '#5989f3',
              foreground: '#fff',
              50: '#172a48',
              100: '#243756',
              200: '#28497a',
              300: '#3561a8',
              400: '#4677dc',
              500: '#5989f3',
              600: '#82aaff',
              700: '#acc7ff',
              800: '#d1e0ff',
              900: '#edf3ff',
            },
            danger: {
              DEFAULT: '#DB3694',
              foreground: '#fff',
              50: '#690A66',
              100: '#7F1170',
              200: '#9D1B7F',
              300: '#BC278B',
              400: '#DB3694',
              500: '#E965A3',
              600: '#F485AE',
              700: '#FBAFC4',
              800: '#FDD7DD',
              900: '#FEEAF6',
            },
          },
        },
      },
    }),
  ],
};

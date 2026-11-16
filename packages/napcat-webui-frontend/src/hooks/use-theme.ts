import { useLocalStorage } from '@uidotdev/usehooks';
import { useEffect } from 'react';

type Theme = 'light' | 'dark';

export const useTheme = (defaultTheme?: Theme) => {
  const preferred = defaultTheme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [storedTheme, setTheme] = useLocalStorage<Theme>('theme', preferred);
  const theme: Theme = storedTheme === 'dark' ? 'dark' : 'light';
  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  return {
    theme,
    isDark: theme === 'dark',
    isLight: theme === 'light',
    setLightTheme: () => setTheme('light'),
    setDarkTheme: () => setTheme('dark'),
    toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
  };
};

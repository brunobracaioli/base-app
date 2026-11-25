import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

export type ThemeMode = 'light' | 'dark' | 'system';

export type ThemeTokens = {
  readonly colors: {
    readonly background: string;
    readonly surface: string;
    readonly text: string;
    readonly mutedText: string;
    readonly border: string;
    readonly primary: string;
    readonly onPrimary: string;
    readonly danger: string;
  };
  readonly spacing: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
  };
  readonly typography: { readonly body: number; readonly title: number; readonly heading: number };
  readonly radius: { readonly sm: number; readonly md: number; readonly lg: number };
};

const storageKey = 'base-app.theme-mode.v1';

const lightTheme: ThemeTokens = {
  colors: {
    background: '#FFFFFF',
    surface: '#F3F4F6',
    text: '#111827',
    mutedText: '#374151',
    border: '#6B7280',
    primary: '#1D4ED8',
    onPrimary: '#FFFFFF',
    danger: '#B91C1C',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  typography: { body: 16, title: 20, heading: 28 },
  radius: { sm: 6, md: 12, lg: 18 },
};

const darkTheme: ThemeTokens = {
  colors: {
    background: '#111827',
    surface: '#1F2937',
    text: '#F9FAFB',
    mutedText: '#D1D5DB',
    border: '#9CA3AF',
    primary: '#93C5FD',
    onPrimary: '#111827',
    danger: '#FCA5A5',
  },
  spacing: lightTheme.spacing,
  typography: lightTheme.typography,
  radius: lightTheme.radius,
};

type ThemeContextValue = {
  readonly mode: ThemeMode;
  readonly resolvedMode: 'light' | 'dark';
  readonly theme: ThemeTokens;
  setMode(mode: ThemeMode): Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function ThemeProvider({ children }: React.PropsWithChildren) {
  const systemMode = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(storageKey)
      .then((savedMode) => {
        if (mounted && isThemeMode(savedMode)) {
          setModeState(savedMode);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    setModeState(nextMode);
    try {
      await AsyncStorage.setItem(storageKey, nextMode);
    } catch {
      // The preference remains available for this app session if local storage is unavailable.
    }
  }, []);

  const resolvedMode = mode === 'system' ? (systemMode === 'dark' ? 'dark' : 'light') : mode;
  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedMode,
      theme: resolvedMode === 'dark' ? darkTheme : lightTheme,
      setMode,
    }),
    [mode, resolvedMode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('ThemeProvider is missing.');
  }
  return value;
}

import { ExecutionEnvironment } from 'expo-constants';

import { isExpoGo, resolveAppVersion } from './app-runtime';

const mockRuntime: {
  executionEnvironment: ExecutionEnvironment;
  expoConfig: { version?: string } | null;
  nativeApplicationVersion: string | null;
} = {
  executionEnvironment: ExecutionEnvironment.Bare,
  expoConfig: null,
  nativeApplicationVersion: null,
};

jest.mock('expo-constants', () => {
  const actual = jest.requireActual<typeof import('expo-constants')>('expo-constants');
  return {
    __esModule: true,
    ExecutionEnvironment: actual.ExecutionEnvironment,
    default: {
      get executionEnvironment() {
        return mockRuntime.executionEnvironment;
      },
      get expoConfig() {
        return mockRuntime.expoConfig;
      },
    },
  };
});

jest.mock('expo-application', () => ({
  get nativeApplicationVersion() {
    return mockRuntime.nativeApplicationVersion;
  },
}));

describe('app runtime', () => {
  it('uses the app config version inside Expo Go instead of the Expo Go native version', () => {
    // arrange
    mockRuntime.executionEnvironment = ExecutionEnvironment.StoreClient;
    mockRuntime.expoConfig = { version: '1.4.0' };
    mockRuntime.nativeApplicationVersion = '58.0.4';

    // act + assert
    expect(isExpoGo()).toBe(true);
    expect(resolveAppVersion()).toBe('1.4.0');
  });

  it('uses the native application version in a development or release build', () => {
    mockRuntime.executionEnvironment = ExecutionEnvironment.Standalone;
    mockRuntime.nativeApplicationVersion = '2.1.0';

    expect(isExpoGo()).toBe(false);
    expect(resolveAppVersion()).toBe('2.1.0');
  });

  it('falls back to 0.0.0 when no version is available', () => {
    mockRuntime.executionEnvironment = ExecutionEnvironment.StoreClient;
    mockRuntime.expoConfig = null;

    expect(resolveAppVersion()).toBe('0.0.0');
  });
});

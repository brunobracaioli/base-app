module.exports = {
  preset: 'jest-expo',
  resolver: '<rootDir>/jest-resolver.cjs',
  // Node 24 supplies web globals; avoid the lazy native WinterCG require under Jest 30.
  moduleNameMapper: {
    '^expo/src/winter$': '<rootDir>/jest-mocks/expo-winter.cjs',
    '^expo/src/winter/(.*)$': '<rootDir>/jest-mocks/expo-winter.cjs',
    '^expo/build/winter/(.*)$': '<rootDir>/jest-mocks/expo-winter.cjs',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    '/node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native|@react-native-community|expo|expo-modules-core|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@noble/ciphers(/|$)))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.test.tsx',
    '<rootDir>/app.config.test.ts',
  ],
  clearMocks: true,
  restoreMocks: true,
  resetMocks: true,
};

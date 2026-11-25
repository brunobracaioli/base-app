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
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.test.tsx',
    '<rootDir>/app.config.test.ts',
  ],
  clearMocks: true,
  restoreMocks: true,
  resetMocks: true,
};

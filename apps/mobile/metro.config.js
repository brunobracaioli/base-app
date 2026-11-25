/* eslint-disable @typescript-eslint/no-require-imports -- Expo and Jest config plugins are CommonJS entrypoints. */
const { getDefaultConfig } = require('expo/metro-config');
const { resolveWorkspaceSource } = require('./metro-resolver.cjs');

const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = resolveWorkspaceSource;

module.exports = config;

/* eslint-disable @typescript-eslint/no-require-imports -- Expo and Jest config plugins are CommonJS entrypoints. */
const { withInfoPlist } = require('expo/config-plugins');

function withNoIosAtsExceptions(config) {
  return withInfoPlist(config, (modConfig) => {
    delete modConfig.modResults.NSAppTransportSecurity;
    return modConfig;
  });
}

module.exports = withNoIosAtsExceptions;

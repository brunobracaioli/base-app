/* eslint-disable @typescript-eslint/no-require-imports -- Expo and Jest config plugins are CommonJS entrypoints. */
const fs = require('node:fs');
const path = require('node:path');

module.exports = (request, options) => {
  if (request.startsWith('.') && request.endsWith('.js')) {
    const candidateBase = path.resolve(options.basedir, request).slice(0, -'.js'.length);
    for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
      const candidate = `${candidateBase}${extension}`;
      if (fs.existsSync(candidate)) {
        return options.defaultResolver(candidate, options);
      }
    }
  }
  return options.defaultResolver(request, options);
};

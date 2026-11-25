const fs = require('node:fs');
const path = require('node:path');

const sensitiveRoutes = [
  'src/app/(auth)/code.tsx',
  'src/app/(auth)/new-password.tsx',
  'src/app/(app)/reauth.tsx',
  'src/app/(app)/settings/export-data.tsx',
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function inspectRouteSource(source, filePath) {
  const failures = [];
  if (/\buseEffect\s*\(/.test(source)) {
    failures.push(`${filePath}: route files cannot run effects on mount.`);
  }
  if (/\b(?:mutate|mutateAsync|fetch)\s*\(/.test(source)) {
    failures.push(`${filePath}: route files cannot perform network or mutation calls.`);
  }
  if (/Linking\.openURL\s*\(/.test(source)) {
    failures.push(`${filePath}: use the openExternalUrl helper for external links.`);
  }
  if (/(?:router\.push|href\s*=)[^\n]*(?:email|code)/i.test(source)) {
    failures.push(`${filePath}: email and verification codes cannot be route parameters.`);
  }

  const imports = source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const imported = match[1] ?? '';
    if (imported.includes('features/') && !imported.includes('/ui')) {
      failures.push(`${filePath}: route imports must target a feature UI entrypoint.`);
    }
    if (imported.includes('@supabase/supabase-js')) {
      failures.push(`${filePath}: routes cannot import the raw Supabase client.`);
    }
  }
  return failures;
}

function validateMobileArchitecture(appRoot = path.resolve(__dirname, '..')) {
  const sourceRoot = path.join(appRoot, 'src');
  const routeRoot = path.join(sourceRoot, 'app');
  const files = walk(sourceRoot).filter(
    (file) => /\.[jt]sx?$/.test(file) && !/\.test\.[jt]sx?$/.test(file),
  );
  const failures = files.flatMap((file) => {
    const relativePath = path.relative(appRoot, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const importFailures = [];
    if (
      /['"]@supabase\/supabase-js['"]/.test(source) &&
      !relativePath.startsWith('src/features/auth/')
    ) {
      importFailures.push(
        `${relativePath}: the raw Supabase client is restricted to auth features.`,
      );
    }
    if (
      relativePath !== 'src/shared/urls/open-external-url.ts' &&
      /Linking\.openURL\s*\(/.test(source)
    ) {
      importFailures.push(`${relativePath}: use the openExternalUrl helper for external links.`);
    }
    if (file.startsWith(routeRoot + path.sep)) {
      return [...inspectRouteSource(source, relativePath), ...importFailures];
    }
    return importFailures;
  });

  for (const route of sensitiveRoutes) {
    const source = fs.readFileSync(path.join(appRoot, route), 'utf8');
    if (!/protectScreen|ScreenCaptureGuard/.test(source)) {
      failures.push(`${route}: sensitive screens must use screen-capture protection.`);
    }
  }

  return failures;
}

if (require.main === module) {
  const failures = validateMobileArchitecture();
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  }
}

module.exports = { inspectRouteSource, validateMobileArchitecture };

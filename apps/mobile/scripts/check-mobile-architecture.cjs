const fs = require('node:fs');
const path = require('node:path');
const typescript = require('typescript');

const captchaAuthMethods = new Set([
  'signUp',
  'signInWithPassword',
  'signInWithOtp',
  'verifyOtp',
  'resetPasswordForEmail',
  'resend',
  'signInAnonymously',
  'signInWithIdToken',
]);
const extensionCaptchaMethods = new Set(['signInAnonymously', 'signInWithIdToken']);

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

function expressionName(expression) {
  if (typescript.isIdentifier(expression)) return expression.text;
  if (typescript.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isCaptchaBoundary(call, captchaHelperIsVerified) {
  let current = call.parent;
  while (current !== undefined) {
    if (typescript.isCallExpression(current)) {
      const name = expressionName(current.expression);
      if (name === 'withCaptcha' || (name === 'captchaCall' && captchaHelperIsVerified)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function hasEnclosingParameter(node, name) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      typescript.isFunctionLike(current) &&
      current.parameters.some(
        (parameter) => typescript.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function facadeWrapsAuthMethod(source, methodName) {
  const sourceFile = typescript.createSourceFile(
    'extension-api.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  let found = false;

  function inspect(node) {
    if (typescript.isCallExpression(node) && expressionName(node.expression) === 'withCaptcha') {
      const callback = node.arguments[2];
      if (callback !== undefined) {
        function inspectCallback(candidate) {
          if (
            typescript.isCallExpression(candidate) &&
            typescript.isPropertyAccessExpression(candidate.expression) &&
            candidate.expression.name.text === methodName &&
            typescript.isIdentifier(candidate.expression.expression) &&
            candidate.expression.expression.text === 'auth'
          ) {
            found = true;
          }
          typescript.forEachChild(candidate, inspectCallback);
        }
        inspectCallback(callback);
      }
    }
    typescript.forEachChild(node, inspect);
  }

  inspect(sourceFile);
  return found;
}

function hasCaptchaCallHelper(source) {
  const sourceFile = typescript.createSourceFile(
    'auth-adapter.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  let helperVerified = false;
  function inspectHelper(node) {
    if (typescript.isFunctionDeclaration(node) && node.name?.text === 'captchaCall') {
      function inspectBody(candidate) {
        if (
          typescript.isCallExpression(candidate) &&
          expressionName(candidate.expression) === 'withCaptcha'
        ) {
          helperVerified = true;
        }
        typescript.forEachChild(candidate, inspectBody);
      }
      if (node.body !== undefined) inspectBody(node.body);
    }
    typescript.forEachChild(node, inspectHelper);
  }
  inspectHelper(sourceFile);
  return helperVerified;
}

function inspectCaptchaUsage(source, filePath, extensionApiSource = '') {
  const sourceFile = typescript.createSourceFile(
    filePath,
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const failures = [];
  const captchaHelperIsVerified = hasCaptchaCallHelper(source);

  function inspect(node) {
    if (
      typescript.isCallExpression(node) &&
      typescript.isPropertyAccessExpression(node.expression) &&
      captchaAuthMethods.has(node.expression.name.text) &&
      typescript.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'auth'
    ) {
      const methodName = node.expression.name.text;
      const wrappedByFacade =
        extensionCaptchaMethods.has(methodName) &&
        hasEnclosingParameter(node, 'captchaToken') &&
        facadeWrapsAuthMethod(extensionApiSource, methodName);
      if (!isCaptchaBoundary(node, captchaHelperIsVerified) && !wrappedByFacade) {
        failures.push(`${filePath}: auth.${methodName} must obtain CAPTCHA through withCaptcha.`);
      }
    }
    typescript.forEachChild(node, inspect);
  }

  inspect(sourceFile);
  return failures;
}

function verifyCaptchaGuardFixtures() {
  const bypass = `function login(client) { return client.auth.signInWithOtp({ email: 'x@example.invalid' }); }`;
  const wrapped = `function login(client) { return withCaptcha(null, 'sign_in_otp', (token) => client.auth.signInWithOtp({ email: 'x@example.invalid', options: token === undefined ? {} : { captchaToken: token } })); }`;
  const bypassFailures = inspectCaptchaUsage(bypass, 'auth-captcha-bypass.fixture.ts');
  const wrappedFailures = inspectCaptchaUsage(wrapped, 'auth-captcha-wrapped.fixture.ts');
  return [
    ...(bypassFailures.length === 0
      ? ['The CAPTCHA static guard failed to reject an SDK bypass fixture.']
      : []),
    ...(wrappedFailures.length !== 0
      ? ['The CAPTCHA static guard rejected a withCaptcha-wrapped fixture.']
      : []),
  ];
}

function validateMobileArchitecture(appRoot = path.resolve(__dirname, '..')) {
  const sourceRoot = path.join(appRoot, 'src');
  const routeRoot = path.join(sourceRoot, 'app');
  const extensionApiSource = fs.readFileSync(
    path.join(sourceRoot, 'composition/extension-api.ts'),
    'utf8',
  );
  const files = walk(sourceRoot).filter(
    (file) => /\.[jt]sx?$/.test(file) && !/\.test\.[jt]sx?$/.test(file),
  );
  const failures = [
    ...verifyCaptchaGuardFixtures(),
    ...files.flatMap((file) => {
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
      if (relativePath.startsWith('src/features/auth/adapters/')) {
        importFailures.push(...inspectCaptchaUsage(source, relativePath, extensionApiSource));
      }
      if (file.startsWith(routeRoot + path.sep)) {
        return [...inspectRouteSource(source, relativePath), ...importFailures];
      }
      return importFailures;
    }),
  ];

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

module.exports = {
  inspectCaptchaUsage,
  inspectRouteSource,
  validateMobileArchitecture,
};

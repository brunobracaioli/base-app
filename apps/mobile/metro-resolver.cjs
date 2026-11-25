const productConfigSourcePattern = /[\\/]packages[\\/]config[\\/]src[\\/]/;

function resolveWorkspaceSource(context, moduleName, platform) {
  const originPath = context.originModulePath ?? '';
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (originalError) {
    if (
      productConfigSourcePattern.test(originPath) &&
      moduleName.startsWith('.') &&
      moduleName.endsWith('.js')
    ) {
      for (const extension of ['.ts', '.tsx']) {
        const TypeScriptSource = `${moduleName.slice(0, -'.js'.length)}${extension}`;
        try {
          return context.resolveRequest(context, TypeScriptSource, platform);
        } catch {
          // Try the next source extension before returning the original resolution failure.
        }
      }
    }

    throw originalError;
  }
}

module.exports = { resolveWorkspaceSource };

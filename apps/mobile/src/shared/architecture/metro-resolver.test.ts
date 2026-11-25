import { createRequire } from 'node:module';

const loadCommonJs = createRequire(import.meta.url);
const resolverModule = loadCommonJs('../../../metro-resolver.cjs') as {
  resolveWorkspaceSource(
    context: {
      originModulePath: string;
      resolveRequest(context: unknown, name: string, platform: string): unknown;
    },
    moduleName: string,
    platform: string,
  ): unknown;
};

describe('Metro product-config source resolver', () => {
  it('maps NodeNext .js specifiers to workspace TypeScript sources', () => {
    const calls: string[] = [];
    const context = {
      originModulePath: '/repo/packages/config/src/product.config.ts',
      resolveRequest: (_context: unknown, name: string) => {
        calls.push(name);
        if (name === './product.schema.js') {
          throw new Error('JavaScript file does not exist.');
        }
        if (name === './product.schema.ts') {
          return { filePath: '/repo/packages/config/src/product.schema.ts' };
        }
        throw new Error('not found');
      },
    };

    expect(
      resolverModule.resolveWorkspaceSource(context, './product.schema.js', 'android'),
    ).toEqual({
      filePath: '/repo/packages/config/src/product.schema.ts',
    });
    expect(calls).toEqual(['./product.schema.js', './product.schema.ts']);
  });

  it('leaves normal JavaScript and non-workspace imports unchanged', () => {
    const calls: string[] = [];
    const context = {
      originModulePath: '/repo/apps/mobile/src/screen.tsx',
      resolveRequest: (_context: unknown, name: string) => {
        calls.push(name);
        return { filePath: name };
      },
    };

    resolverModule.resolveWorkspaceSource(context, './screen.js', 'android');
    expect(calls).toEqual(['./screen.js']);
  });

  it('prefers a real JavaScript file when it exists beside a TypeScript source', () => {
    const calls: string[] = [];
    const context = {
      originModulePath: '/repo/packages/config/src/product.config.ts',
      resolveRequest: (_context: unknown, name: string) => {
        calls.push(name);
        return { filePath: name };
      },
    };

    resolverModule.resolveWorkspaceSource(context, './product.schema.js', 'android');
    expect(calls).toEqual(['./product.schema.js']);
  });

  it('does not rewrite package-contract imports because they resolve from built dist', () => {
    const calls: string[] = [];
    const context = {
      originModulePath: '/repo/packages/contracts/src/index.ts',
      resolveRequest: (_context: unknown, name: string) => {
        calls.push(name);
        throw new Error('not found');
      },
    };

    expect(() =>
      resolverModule.resolveWorkspaceSource(context, './health.schema.js', 'android'),
    ).toThrow('not found');
    expect(calls).toEqual(['./health.schema.js']);
  });
});

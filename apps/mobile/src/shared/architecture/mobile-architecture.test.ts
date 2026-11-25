import { createRequire } from 'node:module';

const loadCommonJs = createRequire(import.meta.url);
const architecture = loadCommonJs('../../../scripts/check-mobile-architecture.cjs') as {
  inspectRouteSource(source: string, filePath: string): string[];
  validateMobileArchitecture(): string[];
};

describe('mobile source boundaries', () => {
  it('passes the current route tree', () => {
    expect(architecture.validateMobileArchitecture()).toEqual([]);
  });

  it('rejects route effects, mutations, raw URL opening, and sensitive route params', () => {
    const failures = architecture.inspectRouteSource(
      `useEffect(() => { mutate(); Linking.openURL(url); router.push({ pathname: '/code', params: { email } }); }, []);`,
      'src/app/(auth)/bad.tsx',
    );
    expect(failures).toHaveLength(4);
  });
});

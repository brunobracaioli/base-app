import productConfig from '@base-app/config/product.config';
import { describe, expect, it } from 'vitest';

import { createDefaultRouteDependencies } from './runtime';

describe('default API runtime configuration', () => {
  it('uses the trusted product configuration for recent authentication', () => {
    expect(createDefaultRouteDependencies().recentAuthMaxAgeSec).toBe(
      productConfig.auth.recentAuthMaxAgeSec,
    );
  });

  it('allows the composition root to inject a validated product value', () => {
    expect(createDefaultRouteDependencies({ recentAuthMaxAgeSec: 60 }).recentAuthMaxAgeSec).toBe(
      60,
    );
  });
});

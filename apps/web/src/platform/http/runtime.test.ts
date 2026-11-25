import productConfig from '@base-app/config/product.config';
import { describe, expect, it } from 'vitest';

import { createDefaultRouteDependencies } from './runtime';

describe('default API runtime configuration', () => {
  it('uses the trusted product configuration for recent authentication', () => {
    expect(createDefaultRouteDependencies().recentAuthMaxAgeSec).toBe(
      productConfig.auth.recentAuthMaxAgeSec,
    );
  });

  it('lets health and app-config skip remote gate initialization', async () => {
    const dependencies = createDefaultRouteDependencies();
    const request = new Request('https://app.example.invalid/api/v1/health');
    await expect(
      dependencies.checkVersionAndMaintenance({
        request,
        operationId: 'getHealth',
        maintenance: 'block',
      }),
    ).resolves.toEqual({ allow: true });
    await expect(
      dependencies.checkVersionAndMaintenance({
        request,
        operationId: 'getAppConfig',
        maintenance: 'block',
      }),
    ).resolves.toEqual({ allow: true });
  });

  it('allows the composition root to inject a validated product value', () => {
    expect(createDefaultRouteDependencies({ recentAuthMaxAgeSec: 60 }).recentAuthMaxAgeSec).toBe(
      60,
    );
  });
});

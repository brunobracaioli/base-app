import product from '@base-app/config/product.config';

import { createOpenExternalUrl } from './open-external-url';

export { createOpenExternalUrl } from './open-external-url';

export const openExternalUrl = createOpenExternalUrl({
  allowedOrigins: [product.web.origin],
});

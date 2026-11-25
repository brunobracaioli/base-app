import { siteExtensions } from '../src/extensions/site';
import { composeSiteExtensions } from '../src/platform/extensions/composition';

try {
  composeSiteExtensions(siteExtensions, process.env);
  process.stdout.write('Site extension public environment validation passed.\n');
} catch {
  process.stderr.write('Site extension public environment validation failed.\n');
  process.exitCode = 1;
}

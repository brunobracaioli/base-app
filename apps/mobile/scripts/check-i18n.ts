import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateLocaleKeyParity,
  type LocaleResources,
} from '../src/shared/i18n/check-locale-parity.ts';

const localesRoot = join(process.cwd(), 'src/shared/i18n/locales');
const resources: Record<string, Record<string, Readonly<Record<string, unknown>>>> = {};

for (const locale of readdirSync(localesRoot).sort()) {
  const localePath = join(localesRoot, locale);
  resources[locale] = {};
  for (const file of readdirSync(localePath)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const namespace = file.slice(0, -'.json'.length);
    resources[locale][namespace] = JSON.parse(
      readFileSync(join(localePath, file), 'utf8'),
    ) as Record<string, unknown>;
  }
}

try {
  validateLocaleKeyParity(resources as LocaleResources);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Locale validation failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

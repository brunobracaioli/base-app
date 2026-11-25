export class LocaleKeyParityError extends Error {
  readonly issue: string;

  constructor(issue: string) {
    super(issue);
    this.issue = issue;
    this.name = 'LocaleKeyParityError';
  }
}

export type LocaleResources = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
>;

function flattenKeys(value: Readonly<Record<string, unknown>>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      return flattenKeys(child as Readonly<Record<string, unknown>>, next);
    }
    return [next];
  });
}

export function validateLocaleKeyParity(resources: LocaleResources): void {
  const locales = Object.keys(resources).sort();
  if (locales.length < 2) {
    throw new LocaleKeyParityError('At least two locales are required.');
  }

  const baselineLocale = locales[0];
  if (baselineLocale === undefined) {
    throw new LocaleKeyParityError('No locales were found.');
  }

  const baseline = resources[baselineLocale];
  if (baseline === undefined) {
    throw new LocaleKeyParityError(`Locale ${baselineLocale} is missing.`);
  }

  const namespaceNames = Object.keys(baseline).sort();
  const baselineKeys = new Map(
    namespaceNames.map((namespace) => [namespace, flattenKeys(baseline[namespace] ?? {}).sort()]),
  );

  for (const locale of locales.slice(1)) {
    const candidate = resources[locale];
    if (candidate === undefined) {
      throw new LocaleKeyParityError(`Locale ${locale} is missing.`);
    }

    const candidateNamespaces = Object.keys(candidate).sort();
    if (JSON.stringify(candidateNamespaces) !== JSON.stringify(namespaceNames)) {
      throw new LocaleKeyParityError(`Namespace mismatch for locale ${locale}.`);
    }

    for (const namespace of namespaceNames) {
      const expected = baselineKeys.get(namespace) ?? [];
      const actual = flattenKeys(candidate[namespace] ?? {}).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new LocaleKeyParityError(`Key mismatch in ${namespace} for locale ${locale}.`);
      }
    }
  }
}

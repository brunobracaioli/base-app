import { Redirect, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import * as z from 'zod';

export type ValidatedParamsResult<T> =
  { readonly success: true; readonly data: T } | { readonly success: false };

export function parseValidatedParams<T>(
  schema: z.ZodType<T>,
  params: unknown,
): ValidatedParamsResult<T> {
  const parsed = schema.safeParse(params);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

export function ValidatedRouteParams<T>({
  schema,
  render,
}: {
  readonly schema: z.ZodType<T>;
  readonly render: (params: T) => ReactNode;
}): ReactNode {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const parsed = parseValidatedParams(schema, params);
  if (!parsed.success) {
    return <Redirect href="/+not-found" />;
  }
  return render(parsed.data);
}

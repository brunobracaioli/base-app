import * as z from 'zod';

import { parseValidatedParams } from './validated-params';

describe('validated route parameters', () => {
  const schema = z.strictObject({ id: z.uuid() });

  it('returns parsed values only for valid route parameters', () => {
    expect(parseValidatedParams(schema, { id: '5fa6acc4-75aa-4e60-8129-3db379c1c804' })).toEqual({
      success: true,
      data: { id: '5fa6acc4-75aa-4e60-8129-3db379c1c804' },
    });
    expect(parseValidatedParams(schema, { id: 'hostile', extra: true })).toEqual({
      success: false,
    });
  });
});

import { AppConfigOperatorError } from './environment';

function scanWhitespace(source: string, state: { offset: number }): void {
  while (state.offset < source.length && /\s/.test(source[state.offset] ?? '')) state.offset += 1;
}

function scanString(source: string, state: { offset: number }): string {
  const start = state.offset;
  state.offset += 1;
  while (state.offset < source.length) {
    const character = source[state.offset];
    if (character === '\\') {
      state.offset += 2;
      continue;
    }
    if (character === '"') {
      state.offset += 1;
      const token = source.slice(start, state.offset);
      const parsed: unknown = JSON.parse(token);
      if (typeof parsed !== 'string') throw new Error('invalid JSON string');
      return parsed;
    }
    state.offset += 1;
  }
  throw new Error('unterminated JSON string');
}

function scanValue(source: string, state: { offset: number }, depth: number): void {
  if (depth > 64) throw new Error('JSON nesting is too deep');
  scanWhitespace(source, state);
  const character = source[state.offset];
  if (character === '"') {
    scanString(source, state);
    return;
  }
  if (character === '{') {
    state.offset += 1;
    scanWhitespace(source, state);
    if (source[state.offset] === '}') {
      state.offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (state.offset < source.length) {
      scanWhitespace(source, state);
      if (source[state.offset] !== '"') throw new Error('JSON object key is invalid');
      const key = scanString(source, state);
      if (keys.has(key)) throw new Error('duplicate JSON object key');
      keys.add(key);
      scanWhitespace(source, state);
      if (source[state.offset] !== ':') throw new Error('JSON object separator is invalid');
      state.offset += 1;
      scanValue(source, state, depth + 1);
      scanWhitespace(source, state);
      if (source[state.offset] === '}') {
        state.offset += 1;
        return;
      }
      if (source[state.offset] !== ',') throw new Error('JSON object delimiter is invalid');
      state.offset += 1;
    }
    throw new Error('JSON object is unterminated');
  }
  if (character === '[') {
    state.offset += 1;
    scanWhitespace(source, state);
    if (source[state.offset] === ']') {
      state.offset += 1;
      return;
    }
    while (state.offset < source.length) {
      scanValue(source, state, depth + 1);
      scanWhitespace(source, state);
      if (source[state.offset] === ']') {
        state.offset += 1;
        return;
      }
      if (source[state.offset] !== ',') throw new Error('JSON array delimiter is invalid');
      state.offset += 1;
    }
    throw new Error('JSON array is unterminated');
  }
  const start = state.offset;
  while (state.offset < source.length && !/[\s,\]}]/.test(source[state.offset] ?? '')) {
    state.offset += 1;
  }
  if (state.offset === start) throw new Error('JSON value is missing');
}

/** Parse JSON while rejecting duplicate members before JSON.parse collapses them. */
export function parseJsonRejectDuplicateMembers(source: string): unknown {
  try {
    const state = { offset: 0 };
    scanValue(source, state, 0);
    scanWhitespace(source, state);
    if (state.offset !== source.length) throw new Error('trailing JSON content');
    return JSON.parse(source) as unknown;
  } catch {
    throw new AppConfigOperatorError(
      'app_config.invalid_json',
      'The supplied JSON is invalid or ambiguous.',
    );
  }
}

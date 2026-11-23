import { describe, expect, it } from 'vitest';
import {
  configFromEntries,
  entriesFromConfig,
  type ConfigEntry,
} from './config-entries';

describe('config-entries', () => {
  it('round-trips flat string entries', () => {
    const entries: ConfigEntry[] = [
      { key: 'model', value: 'gpt' },
      { key: 'temp', value: '0.2' },
    ];
    expect(configFromEntries(entries)).toEqual({ model: 'gpt', temp: 0.2 });
    expect(entriesFromConfig({ model: 'gpt', temp: 0.2 })).toEqual([
      { key: 'model', value: 'gpt' },
      { key: 'temp', value: '0.2' },
    ]);
  });

  it('skips blank keys and empty trailing rows', () => {
    expect(
      configFromEntries([
        { key: '', value: 'x' },
        { key: 'a', value: '1' },
        { key: '  ', value: 'y' },
      ])
    ).toEqual({ a: 1 });
  });

  it('parses JSON object/array values', () => {
    expect(
      configFromEntries([{ key: 'tools', value: '["a","b"]' }])
    ).toEqual({ tools: ['a', 'b'] });
  });

  it('starts from empty object as one blank row', () => {
    expect(entriesFromConfig({})).toEqual([{ key: '', value: '' }]);
  });
});

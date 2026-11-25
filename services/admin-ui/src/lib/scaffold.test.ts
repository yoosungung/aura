import { describe, expect, it } from 'vitest';
import { scaffoldFor, scaffoldSlots } from './scaffold';

describe('scaffold', () => {
  it('maps kind×runtime to static href', () => {
    expect(scaffoldFor('agent', 'nodejs')?.href).toBe(
      '/scaffolds/agent-nodejs/main.js'
    );
    expect(scaffoldFor('mcp', 'python')?.file).toBe('main.py');
  });

  it('returns null for custom', () => {
    expect(scaffoldFor('agent', 'custom')).toBeNull();
  });

  it('lists four slots', () => {
    expect(scaffoldSlots()).toHaveLength(4);
  });
});

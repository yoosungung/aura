import { describe, expect, it } from 'vitest';
import { scaffoldFor, scaffoldSlots } from './scaffold';

describe('scaffold', () => {
  it('maps kind×runtime to zip href', () => {
    expect(scaffoldFor('agent', 'nodejs')?.href).toBe(
      '/scaffolds/agent-nodejs.zip'
    );
    expect(scaffoldFor('mcp', 'python')?.file).toBe('mcp-python.zip');
    expect(scaffoldFor('agent', 'nodejs')?.depsFile).toBe('package.json');
  });

  it('returns null for custom', () => {
    expect(scaffoldFor('agent', 'custom')).toBeNull();
  });

  it('lists four slots', () => {
    expect(scaffoldSlots()).toHaveLength(4);
  });
});

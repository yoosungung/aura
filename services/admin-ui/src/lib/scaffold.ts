export type ScaffoldSlot = {
  kind: 'agent' | 'mcp';
  runtime: 'nodejs' | 'python';
  dir: string;
  file: string;
  href: string;
};

const SLOTS: ScaffoldSlot[] = [
  {
    kind: 'agent',
    runtime: 'nodejs',
    dir: 'agent-nodejs',
    file: 'main.js',
    href: '/scaffolds/agent-nodejs/main.js',
  },
  {
    kind: 'agent',
    runtime: 'python',
    dir: 'agent-python',
    file: 'main.py',
    href: '/scaffolds/agent-python/main.py',
  },
  {
    kind: 'mcp',
    runtime: 'nodejs',
    dir: 'mcp-nodejs',
    file: 'main.js',
    href: '/scaffolds/mcp-nodejs/main.js',
  },
  {
    kind: 'mcp',
    runtime: 'python',
    dir: 'mcp-python',
    file: 'main.py',
    href: '/scaffolds/mcp-python/main.py',
  },
];

export function scaffoldFor(
  kind: string,
  runtime: string
): ScaffoldSlot | null {
  return (
    SLOTS.find((s) => s.kind === kind && s.runtime === runtime) || null
  );
}

export function scaffoldSlots(): ScaffoldSlot[] {
  return [...SLOTS];
}

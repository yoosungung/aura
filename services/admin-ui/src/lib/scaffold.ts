export type ScaffoldSlot = {
  kind: 'agent' | 'mcp';
  runtime: 'nodejs' | 'python';
  dir: string;
  /** Zip download filename */
  file: string;
  href: string;
  depsFile: string;
};

const SLOTS: ScaffoldSlot[] = [
  {
    kind: 'agent',
    runtime: 'nodejs',
    dir: 'agent-nodejs',
    file: 'agent-nodejs.zip',
    href: '/scaffolds/agent-nodejs.zip',
    depsFile: 'package.json',
  },
  {
    kind: 'agent',
    runtime: 'python',
    dir: 'agent-python',
    file: 'agent-python.zip',
    href: '/scaffolds/agent-python.zip',
    depsFile: 'requirements.txt',
  },
  {
    kind: 'mcp',
    runtime: 'nodejs',
    dir: 'mcp-nodejs',
    file: 'mcp-nodejs.zip',
    href: '/scaffolds/mcp-nodejs.zip',
    depsFile: 'package.json',
  },
  {
    kind: 'mcp',
    runtime: 'python',
    dir: 'mcp-python',
    file: 'mcp-python.zip',
    href: '/scaffolds/mcp-python.zip',
    depsFile: 'requirements.txt',
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

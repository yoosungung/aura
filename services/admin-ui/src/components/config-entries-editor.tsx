import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ConfigEntry } from '@/lib/config-entries';

type Props = {
  id: string;
  label?: string;
  entries: ConfigEntry[];
  onChange: (next: ConfigEntry[]) => void;
};

export function ConfigEntriesEditor({
  id,
  label = 'Config',
  entries,
  onChange,
}: Props) {
  function update(index: number, patch: Partial<ConfigEntry>) {
    onChange(entries.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    onChange([...entries, { key: '', value: '' }]);
  }

  function removeRow(index: number) {
    if (entries.length <= 1) {
      onChange([{ key: '', value: '' }]);
      return;
    }
    onChange(entries.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-0-key`}>{label}</Label>
      <div className="space-y-2">
        {entries.map((row, index) => (
          <div key={`${id}-${index}`} className="flex flex-wrap gap-2">
            <Input
              id={`${id}-${index}-key`}
              value={row.key}
              onChange={(e) => update(index, { key: e.target.value })}
              placeholder="key"
              className="min-w-[8rem] flex-1"
            />
            <Input
              id={`${id}-${index}-value`}
              value={row.value}
              onChange={(e) => update(index, { value: e.target.value })}
              placeholder="value"
              className="min-w-[10rem] flex-[2]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => removeRow(index)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button id={`${id}-add`} type="button" variant="outline" size="sm" onClick={addRow}>
        Add field
      </Button>
      <p className="text-xs text-neutral-500">
        Empty keys are ignored. Numbers/bools/JSON arrays parse automatically. No{' '}
        <code>runtime</code> key.
      </p>
    </div>
  );
}

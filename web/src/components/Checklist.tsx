import type { RunDetail } from '../api/types';

export default function Checklist({
  items,
  disabled,
  onToggle,
}: {
  items: RunDetail['checklist'];
  disabled: boolean;
  onToggle: (key: string, ticked: boolean) => void;
}) {
  const done = items.filter((i) => i.ticked).length;
  return (
    <section className="space-y-2 rounded border bg-white p-4" aria-label="Safety checklist">
      <h2 className="font-semibold">
        Safety checklist{' '}
        <span className={`text-sm font-normal ${done === items.length ? 'text-green-700' : 'text-gray-600'}`}>
          {done} / {items.length} ticked
        </span>
      </h2>
      <p className="text-xs text-gray-500">
        Tick each item at the machine. The list starts empty for every run.
      </p>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.key}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={i.ticked}
                disabled={disabled}
                onChange={(e) => onToggle(i.key, e.target.checked)}
              />
              <span className={i.ticked ? 'text-gray-900' : 'text-gray-700'}>{i.label}</span>
              {i.ticked && i.by && (
                <span className="text-xs text-gray-400">
                  {i.by} {i.at?.slice(11, 19)}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

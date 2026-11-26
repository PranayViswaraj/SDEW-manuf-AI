import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { getBrowserAiKey, setBrowserAiKey } from '../browser-server/install';

/**
 * Hosted build only: switch the two-agent AI reader on with the user's own Anthropic API key.
 * The key is stored in this browser on this computer only and goes nowhere but Anthropic.
 */
export default function BrowserAiKey({ onChange }: { onChange: () => void }) {
  const [saved, setSaved] = useState<string | null>(() => getBrowserAiKey());
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (saved)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm">
        <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
        <span className="flex-1 text-emerald-900">
          AI reader on in this browser (key …{saved.slice(-4)}). Two agents read each new drawing.
        </span>
        <button
          type="button"
          className="btn text-sm"
          onClick={() => {
            setBrowserAiKey(null);
            setSaved(null);
            onChange();
          }}
        >
          Forget key
        </button>
      </div>
    );

  return (
    <form
      className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const k = draft.trim();
        if (!k.startsWith('sk-ant-') || k.length < 40) {
          setProblem('That does not look like an Anthropic API key (it starts with sk-ant-).');
          return;
        }
        setBrowserAiKey(k);
        setSaved(k);
        setDraft('');
        setProblem(null);
        onChange();
      }}
    >
      <p className="flex items-center gap-2 font-semibold text-slate-900">
        <KeyRound className="h-4 w-4 text-sky-600" aria-hidden="true" /> Switch on the AI reader in this
        browser
      </p>
      <p className="text-slate-600">
        Paste your Anthropic API key. It is kept only in this browser on this computer, never in the app, its
        data or on GitHub, and the two agents call Anthropic directly from here. Set a spending limit on the
        key in the Anthropic Console.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input min-w-0 flex-1 font-mono"
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={!draft.trim()}>
          Save in this browser
        </button>
      </div>
      {problem && <p className="text-rose-700">{problem}</p>}
    </form>
  );
}

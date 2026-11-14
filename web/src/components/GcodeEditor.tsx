import { Fragment, useRef, type ChangeEvent } from 'react';
import { Line } from './GcodeView';

/** Editable program text: coloured like the viewer, line numbers, letters kept in capitals
 *  (the FANUC control reads capitals). The text is only checked here; saving is a new version. */
export default function GcodeEditor({
  value,
  onChange,
  changed,
}: {
  value: string;
  onChange: (text: string) => void;
  /** 1-based numbers of lines that differ from the generated program */
  changed: Set<number>;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const under = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n');

  function sync() {
    if (!area.current) return;
    const { scrollTop, scrollLeft } = area.current;
    if (under.current) {
      under.current.scrollTop = scrollTop;
      under.current.scrollLeft = scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = scrollTop;
  }

  function change(e: ChangeEvent<HTMLTextAreaElement>) {
    const el = e.target;
    const { selectionStart, selectionEnd } = el;
    onChange(el.value.toUpperCase());
    // keep the cursor where it was after the text is put in capitals
    requestAnimationFrame(() => el.setSelectionRange(selectionStart, selectionEnd));
  }

  const shared = 'm-0 p-3 font-mono text-xs leading-5 whitespace-pre';
  return (
    <div className="relative flex h-[28rem] overflow-hidden rounded-b-xl bg-slate-950">
      <div
        ref={gutter}
        className="w-12 shrink-0 overflow-hidden border-r border-white/10 py-3 text-right font-mono text-xs leading-5 text-slate-600 select-none"
        aria-hidden="true"
      >
        {lines.map((_, i) => (
          <div key={i} className={`pr-2 ${changed.has(i + 1) ? 'bg-amber-400/15 text-amber-300' : ''}`}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <pre
          ref={under}
          className={`${shared} pointer-events-none absolute inset-0 overflow-hidden text-slate-100`}
          aria-hidden="true"
        >
          {lines.map((l, i) => (
            <Fragment key={i}>
              <Line text={l} />
              {'\n'}
            </Fragment>
          ))}
        </pre>
        <textarea
          ref={area}
          value={value}
          onChange={change}
          onScroll={sync}
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          wrap="off"
          aria-label="Edit program text"
          className={`${shared} absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-white outline-none selection:bg-sky-400/30`}
        />
      </div>
    </div>
  );
}

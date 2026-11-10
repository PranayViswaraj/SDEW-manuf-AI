import type { ReactNode } from 'react';

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
      {error}
    </p>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  const cls =
    tone === 'warn'
      ? 'border-amber-300 bg-amber-50 text-amber-900'
      : tone === 'ok'
        ? 'border-green-300 bg-green-50 text-green-900'
        : 'border-blue-200 bg-blue-50 text-blue-900';
  return <div className={`rounded border p-3 text-sm ${cls}`}>{children}</div>;
}

export function NotEntered({ what = 'Not entered' }: { what?: string }) {
  return <span className="text-sm italic text-amber-700">{what}</span>;
}

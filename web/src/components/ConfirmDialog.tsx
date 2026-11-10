import { useEffect, useRef, type ReactNode } from 'react';

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus(); // safe default: focus Cancel, not Confirm
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="text-sm text-gray-700">{children}</div>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

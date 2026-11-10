import type { ProgramStatus } from '../api/types';

const CLS: Record<ProgramStatus, string> = {
  draft: 'badge-gray',
  approved: 'badge-green',
  rejected: 'badge-red',
  retired: 'badge-amber',
};

export function ProgramStatusBadge({ status }: { status: ProgramStatus }) {
  return <span className={CLS[status]}>{status}</span>;
}

export function ProvenBadge({ proven }: { proven: boolean }) {
  return proven ? (
    <span className="badge-blue" title="First piece passed / supplied as proven">
      proven
    </span>
  ) : null;
}

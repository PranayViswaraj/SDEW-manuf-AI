// Live machine status badge. Filled in by Milestone 8 (bridge).

export function MachineLiveBadge({ machineId }: { machineId: number }) {
  return (
    <span className="badge-gray" data-machine={machineId}>
      No bridge yet
    </span>
  );
}

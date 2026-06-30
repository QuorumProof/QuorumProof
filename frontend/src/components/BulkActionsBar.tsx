interface BulkActionsBarProps {
  selectedCount: number;
  totalCount: number;
  canRevoke: boolean;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onExport: () => void;
  onShare: () => void;
  onRevoke: () => void;
  onExit: () => void;
}

export function BulkActionsBar({
  selectedCount,
  totalCount,
  canRevoke,
  onSelectAll,
  onDeselectAll,
  onExport,
  onShare,
  onRevoke,
  onExit,
}: BulkActionsBarProps) {
  const allSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-bar__left">
        <span className="bulk-bar__count">
          {selectedCount} of {totalCount} selected
        </span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={allSelected ? onDeselectAll : onSelectAll}
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
        {selectedCount > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={onDeselectAll}>
            Clear
          </button>
        )}
      </div>

      <div className="bulk-bar__actions">
        {selectedCount > 0 && (
          <>
            <button className="btn btn--ghost btn--sm" onClick={onShare}>
              🔗 Share ({selectedCount})
            </button>
            <button className="btn btn--primary btn--sm" onClick={onExport}>
              📥 Export ({selectedCount})
            </button>
            {canRevoke && (
              <button className="btn btn--danger btn--sm" onClick={onRevoke}>
                🚫 Revoke ({selectedCount})
              </button>
            )}
          </>
        )}
        <button className="btn btn--ghost btn--sm" onClick={onExit}>
          ✕ Exit Selection
        </button>
      </div>
    </div>
  );
}

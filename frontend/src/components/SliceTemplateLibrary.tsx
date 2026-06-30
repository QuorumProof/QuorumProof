import { useState } from 'react';
import {
  SLICE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  filterByCategory,
} from '../lib/sliceTemplates';
import type { SliceTemplate, TemplateCategory } from '../lib/sliceTemplates';
import type { AttestorEntry } from '../lib/sliceBuilderUtils';

export interface SliceTemplateLibraryProps {
  /** Called when the user clicks "Use Template" on a card. */
  onApply: (attestors: Omit<AttestorEntry, 'id'>[], threshold: number) => void;
}

function TemplateCard({
  template,
  onApply,
}: {
  template: SliceTemplate;
  onApply: SliceTemplateLibraryProps['onApply'];
}) {
  const totalWeight = template.attestors.reduce((s, a) => s + a.weight, 0);
  const pct = totalWeight > 0 ? Math.round((template.threshold / totalWeight) * 100) : 0;

  // Summarise attestors by role
  const roleSummary = template.attestors.reduce<Record<string, number>>((acc, a) => {
    acc[a.role] = (acc[a.role] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="stl-card" role="article" aria-label={template.label}>
      <div className="stl-card__header">
        <span className="stl-card__title">{template.label}</span>
        <span className="stl-card__badge">{template.category}</span>
      </div>
      <p className="stl-card__desc">{template.description}</p>

      {/* Attestor role summary */}
      <ul className="stl-card__roles" aria-label="Attestor roles in template">
        {Object.entries(roleSummary).map(([role, count]) => (
          <li key={role} className="stl-card__role-item">
            {count > 1 ? `${count}× ` : ''}{role}
          </li>
        ))}
      </ul>

      {/* Threshold info */}
      <div className="stl-card__threshold" aria-label={`Threshold: ${template.threshold} of ${totalWeight} weight (${pct}%)`}>
        <span>Threshold</span>
        <span>{template.threshold} / {totalWeight} ({pct}%)</span>
      </div>

      <button
        type="button"
        className="btn btn--ghost btn--sm stl-card__apply"
        onClick={() => onApply(template.attestors, template.threshold)}
        aria-label={`Use template: ${template.label}`}
      >
        Use Template
      </button>
    </div>
  );
}

export function SliceTemplateLibrary({ onApply }: SliceTemplateLibraryProps) {
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | undefined>(undefined);
  const visible = filterByCategory(SLICE_TEMPLATES, activeCategory);

  return (
    <div className="stl" role="region" aria-label="Slice template library">
      {/* Category tabs */}
      <div className="stl__tabs" role="tablist" aria-label="Template categories">
        <button
          type="button"
          role="tab"
          className={`stl__tab${activeCategory === undefined ? ' stl__tab--active' : ''}`}
          aria-selected={activeCategory === undefined}
          onClick={() => setActiveCategory(undefined)}
        >
          All
        </button>
        {TEMPLATE_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            role="tab"
            className={`stl__tab${activeCategory === cat ? ' stl__tab--active' : ''}`}
            aria-selected={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Template cards */}
      <div className="stl__grid" role="list">
        {visible.map((template) => (
          <TemplateCard key={template.id} template={template} onApply={onApply} />
        ))}
      </div>
    </div>
  );
}

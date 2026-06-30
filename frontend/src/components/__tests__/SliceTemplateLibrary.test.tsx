import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  SLICE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  filterByCategory,
} from '../../lib/sliceTemplates';
import type { TemplateCategory } from '../../lib/sliceTemplates';
import { SliceTemplateLibrary } from '../SliceTemplateLibrary';

// ── sliceTemplates data ───────────────────────────────────────────────────────

describe('SLICE_TEMPLATES catalogue', () => {
  it('contains at least one template per category', () => {
    for (const category of TEMPLATE_CATEGORIES) {
      const found = SLICE_TEMPLATES.filter((t) => t.category === category);
      expect(found.length, `No templates in category "${category}"`).toBeGreaterThan(0);
    }
  });

  it('every template has a unique id', () => {
    const ids = SLICE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template threshold is within its total weight', () => {
    for (const t of SLICE_TEMPLATES) {
      const tw = t.attestors.reduce((s, a) => s + a.weight, 0);
      expect(t.threshold, `"${t.id}" threshold < 1`).toBeGreaterThanOrEqual(1);
      expect(t.threshold, `"${t.id}" threshold > total weight`).toBeLessThanOrEqual(tw);
    }
  });

  it('every template has at least one attestor', () => {
    for (const t of SLICE_TEMPLATES) {
      expect(t.attestors.length, `"${t.id}" has no attestors`).toBeGreaterThan(0);
    }
  });

  it('every attestor weight is between 1 and 10', () => {
    for (const t of SLICE_TEMPLATES) {
      for (const a of t.attestors) {
        expect(a.weight).toBeGreaterThanOrEqual(1);
        expect(a.weight).toBeLessThanOrEqual(10);
      }
    }
  });

  it('TEMPLATE_CATEGORIES lists all categories present', () => {
    const inData = new Set(SLICE_TEMPLATES.map((t) => t.category));
    for (const cat of TEMPLATE_CATEGORIES) {
      expect(inData.has(cat)).toBe(true);
    }
  });
});

describe('filterByCategory', () => {
  it('returns all templates when category is undefined', () => {
    expect(filterByCategory(SLICE_TEMPLATES, undefined)).toHaveLength(SLICE_TEMPLATES.length);
  });

  it('returns only matching templates for a given category', () => {
    const result = filterByCategory(SLICE_TEMPLATES, 'Academic');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.category === 'Academic')).toBe(true);
  });

  it('returns an empty array for a category with no templates', () => {
    const empty = filterByCategory(SLICE_TEMPLATES, 'NonExistent' as TemplateCategory);
    expect(empty).toHaveLength(0);
  });
});

// ── SliceTemplateLibrary component ────────────────────────────────────────────

describe('SliceTemplateLibrary', () => {
  it('renders the "All" tab and all category tabs', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    for (const cat of TEMPLATE_CATEGORIES) {
      expect(screen.getByRole('tab', { name: cat })).toBeInTheDocument();
    }
  });

  it('shows all templates by default (All tab active)', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    const cards = screen.getAllByRole('article');
    expect(cards.length).toBe(SLICE_TEMPLATES.length);
  });

  it('filters templates when a category tab is clicked', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Academic' }));
    const expected = SLICE_TEMPLATES.filter((t) => t.category === 'Academic').length;
    expect(screen.getAllByRole('article')).toHaveLength(expected);
  });

  it('returns to all templates when "All" tab is re-clicked', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Minimal' }));
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByRole('article')).toHaveLength(SLICE_TEMPLATES.length);
  });

  it('calls onApply with correct attestors and threshold when "Use Template" is clicked', () => {
    const onApply = vi.fn();
    render(<SliceTemplateLibrary onApply={onApply} />);

    // Click the first "Use Template" button
    const buttons = screen.getAllByText('Use Template');
    fireEvent.click(buttons[0]);

    const firstTemplate = SLICE_TEMPLATES[0];
    expect(onApply).toHaveBeenCalledOnce();
    const [attestors, threshold] = onApply.mock.calls[0] as [typeof firstTemplate.attestors, number];
    expect(threshold).toBe(firstTemplate.threshold);
    expect(attestors).toHaveLength(firstTemplate.attestors.length);
    expect(attestors[0].role).toBe(firstTemplate.attestors[0].role);
    expect(attestors[0].weight).toBe(firstTemplate.attestors[0].weight);
  });

  it('marks the clicked category tab as selected', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    const profTab = screen.getByRole('tab', { name: 'Professional' });
    fireEvent.click(profTab);
    expect(profTab).toHaveAttribute('aria-selected', 'true');
  });

  it('"All" tab is selected by default', () => {
    render(<SliceTemplateLibrary onApply={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });
});

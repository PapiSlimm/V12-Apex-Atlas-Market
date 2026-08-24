import React from 'react';

/*
 * Enterprise table.
 *
 * A real `<table>` with a real `<caption>` and real `<th scope>`, because a grid
 * of divs is unnavigable with a screen reader — there is no way to ask "what
 * column am I in?" of a stack of flexbox rows.
 *
 * Numeric columns get `tabular-nums` and right alignment. That is the case
 * where fixed-width digits are correct: a column of figures has to line up.
 * Display values elsewhere deliberately do not use it.
 */

export interface Column<Row> {
  key: string;
  header: string;
  /** Right-aligns and switches on tabular figures. */
  numeric?: boolean;
  width?: string;
  render: (row: Row) => React.ReactNode;
}

export interface DataTableProps<Row> {
  /** Describes the table for assistive tech. Visually hidden by default. */
  caption: string;
  captionVisible?: boolean;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  empty?: string;
  onRowSelect?: (row: Row) => void;
  isSelected?: (row: Row) => boolean;
}

export function DataTable<Row>({
  caption,
  captionVisible = false,
  columns,
  rows,
  rowKey,
  empty = 'Nothing to show.',
  onRowSelect,
  isSelected,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-center py-4" style={{ color: 'var(--ink-muted)' }}>
        {empty}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <caption
          className={captionVisible ? 'text-left text-[11px] pb-2' : 'sr-only'}
          style={{ color: 'var(--ink-secondary)' }}
        >
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ width: column.width, color: 'var(--ink-muted)', borderColor: 'var(--line-subtle)' }}
                className={`border-b pb-1.5 font-normal ${column.numeric ? 'text-right' : 'text-left'}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = isSelected?.(row) ?? false;
            return (
              <tr
                key={rowKey(row, index)}
                aria-selected={onRowSelect ? selected : undefined}
                tabIndex={onRowSelect ? 0 : undefined}
                onClick={onRowSelect ? () => onRowSelect(row) : undefined}
                onKeyDown={
                  onRowSelect
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowSelect(row);
                        }
                      }
                    : undefined
                }
                className={onRowSelect ? 'cursor-pointer' : ''}
                style={{ background: selected ? 'var(--surface-3)' : undefined }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{ borderColor: 'var(--line-subtle)', color: 'var(--ink-secondary)' }}
                    className={`border-b py-1.5 align-top ${
                      column.numeric ? 'text-right tabular' : 'text-left'
                    }`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

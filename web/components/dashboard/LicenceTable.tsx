/**
 * Licences as a table on wide screens and as stacked cards below 900 px. Both views render the same
 * cells; the first column is the card's heading on phones.
 */
import type { ReactNode } from "react";

export type Column<T> = { header: string; cell: (row: T) => ReactNode; className?: string };

export function LicenceTable<T>({
  rows,
  rowKey,
  columns,
  actions,
  muted,
  caption,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  columns: Column<T>[];
  actions?: (row: T) => ReactNode;
  /** Ended licences read quieter. */
  muted?: (row: T) => boolean;
  caption: string;
}) {
  const [first, ...rest] = columns;
  return (
    <>
      <table className="hidden w-full border-collapse text-[14px] desk:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-[12px] text-grey">
            {columns.map((c) => (
              <th key={c.header} scope="col" className="py-2 pr-3 font-medium">
                {c.header}
              </th>
            ))}
            {actions && (
              <th scope="col" className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={`border-t border-divider align-middle ${muted?.(r) ? "text-grey" : ""}`}>
              {columns.map((c) => (
                <td key={c.header} className={`py-3 pr-3 ${c.className ?? ""}`}>
                  {c.cell(r)}
                </td>
              ))}
              {actions && (
                <td className="py-3 text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">{actions(r)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <ul aria-label={caption} className="m-0 flex list-none flex-col gap-2.5 p-0 desk:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={`flex flex-col gap-2.5 rounded-[16px] border border-divider p-3.5 text-[14px] ${muted?.(r) ? "text-grey" : ""}`}>
            <div>{first.cell(r)}</div>
            <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              {rest.map((c) => (
                <div key={c.header} className="contents">
                  <dt className="text-[12px] text-grey">{c.header}</dt>
                  <dd className="m-0">{c.cell(r)}</dd>
                </div>
              ))}
            </dl>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions(r)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

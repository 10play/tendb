import { formatCell, formatCount } from "../lib/format";
import type { QueryOk } from "../lib/api";

export function ResultGrid({ result }: { result: QueryOk }) {
  if (result.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center">
        <p className="text-[13px] text-dim">
          <span className="font-mono text-ink">{result.command ?? "Statement"}</span> affected{" "}
          <span className="font-mono text-ink">{formatCount(result.rowCount)}</span>{" "}
          {result.rowCount === 1 ? "row" : "rows"}. No rows to show.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left font-mono text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr>
            {result.columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                className="label-eyebrow border-r border-b border-line bg-panel px-3 py-2 font-normal whitespace-nowrap last:border-r-0"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line/60 last:border-b-0 hover:bg-raised/40">
              {result.columns.map((_column, cellIndex) => {
                const value = row[cellIndex];
                const isNull = value === null || value === undefined;
                return (
                  <td
                    key={cellIndex}
                    title={isNull ? undefined : formatCell(value)}
                    className={`max-w-[26rem] truncate border-r border-line/60 px-3 py-1.5 last:border-r-0 ${
                      isNull ? "text-faint italic" : "text-dim"
                    }`}
                  >
                    {formatCell(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {result.rows.length === 0 ? (
        <p className="px-3 py-8 text-center text-[13px] text-faint">No rows returned.</p>
      ) : null}
    </div>
  );
}

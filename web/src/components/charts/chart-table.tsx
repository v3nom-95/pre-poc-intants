export function ChartTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="max-h-[260px] overflow-auto rounded-md border border-(--rule)">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-(--sheet)">
          <tr>
            {columns.map((c) => (
              <th key={c} className="border-b border-(--rule) px-3 py-2 text-left font-semibold text-(--ink-2)">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-(--rule) last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="tabular px-3 py-1.5 text-(--ink)">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

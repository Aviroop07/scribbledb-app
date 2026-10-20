// The schema as a Mermaid ER diagram (erDiagram source). Pure: used by the page (rendered to SVG) and the package
// (er_diagram.mmd). Input: state.tables - [{name, columns: [{name, type, notnull, pk}], references, fks?}].
//
// Mermaid's ER grammar accepts only word characters in entity names, attribute types and attribute names, so each
// is reduced to [A-Za-z0-9_] (VARCHAR(20) -> VARCHAR_20, an empty type -> ANY); a relationship label is quoted.
// A foreign key from child.c to parent: "parent ||--o{ child" when c is NOT NULL (every child has exactly one
// parent), "parent |o--o{ child" when c may be NULL.

const word = (s, fallback) => (String(s ?? "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback);

export function erDiagram(tables) {
  const lines = ["erDiagram"];
  for (const t of tables) {
    const fkCols = new Set((t.fks || []).map((f) => f.from));
    lines.push(`  ${word(t.name, "table")} {`);
    for (const c of t.columns) {
      const keys = [c.pk && "PK", fkCols.has(c.name) && "FK"].filter(Boolean).join(",");
      lines.push(`    ${word(c.type, "ANY")} ${word(c.name, "column")}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const t of tables) {
    const links = t.fks && t.fks.length ? t.fks : t.references.map((r) => ({ from: "", table: r, to: "" }));
    for (const f of links) {
      if (!tables.some((x) => x.name === f.table)) continue;
      const col = t.columns.find((c) => c.name === f.from);
      const left = col && !col.notnull && !col.pk ? "|o" : "||";
      lines.push(`  ${word(f.table, "table")} ${left}--o{ ${word(t.name, "table")} : "${String(f.from || "references").replace(/"/g, "'")}"`);
    }
  }
  return lines.join("\n") + "\n";
}

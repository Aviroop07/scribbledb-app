// The ER diagram source: Mermaid's grammar only takes word characters, keys are marked, and each foreign key becomes
// one relationship whose cardinality follows the column's NOT NULL.
import test from "node:test";
import assert from "node:assert/strict";
import { erDiagram } from "../../web/core/er.js";

const TABLES = [
  { name: "authors", columns: [{ name: "author_id", type: "INTEGER", notnull: false, pk: true }, { name: "name", type: "VARCHAR(40)", notnull: true, pk: false }], references: [], fks: [] },
  { name: "books", columns: [{ name: "book_id", type: "INTEGER", pk: true }, { name: "author_id", type: "INTEGER", notnull: true },
    { name: "editor_id", type: "INTEGER", notnull: false }, { name: "price", type: "", notnull: true }], references: ["authors"],
  fks: [{ from: "author_id", table: "authors", to: "author_id" }, { from: "editor_id", table: "authors", to: "author_id" }] },
  { name: "order lines", columns: [{ name: "line id", type: "INTEGER", pk: true }], references: ["books", "gone"], fks: [] },
];

test("entities, attribute types and keys use only characters Mermaid accepts", () => {
  const src = erDiagram(TABLES);
  assert.match(src, /^erDiagram\n/);
  assert.match(src, /  authors \{\n    INTEGER author_id PK\n    VARCHAR_40 name\n  \}/);
  assert.match(src, /    INTEGER author_id FK\n/);
  assert.match(src, /    ANY price\n/); // an empty type
  assert.match(src, /  order_lines \{\n    INTEGER line_id PK\n/); // spaces in names
});

test("one relationship per foreign key; a nullable key is optional on the parent side", () => {
  const src = erDiagram(TABLES);
  assert.match(src, /authors \|\|--o\{ books : "author_id"/);
  assert.match(src, /authors \|o--o\{ books : "editor_id"/);
  // without column-level keys the table references are drawn; a reference to a table not in the schema is skipped
  assert.match(src, /books \|\|--o\{ order_lines : "references"/);
  assert.doesNotMatch(src, /gone/);
});

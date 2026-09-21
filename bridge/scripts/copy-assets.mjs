import { cpSync, mkdirSync } from "node:fs";

// tsc emits code only; the SQL schema and prompt markdown must travel with it.
mkdirSync("dist/db", { recursive: true });
mkdirSync("dist/prompts", { recursive: true });
cpSync("src/db/schema.sql", "dist/db/schema.sql");
for (const name of ["agent-system", "discovery", "research", "personalization"]) {
  cpSync(`src/prompts/${name}.md`, `dist/prompts/${name}.md`);
}
console.log("assets copied");

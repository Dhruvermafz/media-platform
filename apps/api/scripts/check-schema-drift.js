#!/usr/bin/env node
/**
 * Verifies that the database produced by `prisma/migrations/*` matches
 * `prisma/schema.prisma`: tables, columns, types, nullability, unique
 * constraints and foreign keys (including ON DELETE behaviour).
 *
 * Why this exists: migrations in this repo are reviewed SQL, and the
 * workers talk to Postgres with hand-written SQL (see JobStore) rather
 * than through Prisma. A column that exists in schema.prisma but not in a
 * migration (or vice versa) would otherwise only surface at runtime.
 * Run it in CI after `prisma migrate deploy`:
 *
 *   DATABASE_URL=postgresql://... npm run db:check-drift
 *
 * Needs `prisma generate` to have run (it reads the generated DMMF).
 */
const { Client } = require('pg');
const { Prisma } = require('@prisma/client');

const SCALAR_TO_PG = {
  String: ['text'],
  Int: ['integer'],
  BigInt: ['bigint'],
  Boolean: ['boolean'],
  DateTime: ['timestamp without time zone'],
  Json: ['jsonb'],
  Float: ['double precision'],
};
const ON_DELETE = { Cascade: 'CASCADE', SetNull: 'SET NULL', Restrict: 'RESTRICT', NoAction: 'NO ACTION' };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: url });
  await db.connect();
  const problems = [];
  const { models, enums } = Prisma.dmmf.datamodel;
  const enumNames = new Set(enums.map((e) => e.name));

  for (const model of models) {
    const table = model.dbName ?? model.name;
    const { rows: cols } = await db.query(
      `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    if (cols.length === 0) {
      problems.push(`table "${table}" is missing`);
      continue;
    }
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    const scalarFields = model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');

    for (const f of scalarFields) {
      const col = byName.get(f.dbName ?? f.name);
      if (!col) {
        problems.push(`${table}.${f.name}: column is missing`);
        continue;
      }
      if (f.kind === 'enum') {
        if (col.udt_name !== f.type) problems.push(`${table}.${f.name}: expected enum "${f.type}", found "${col.udt_name}"`);
      } else if (!(SCALAR_TO_PG[f.type] ?? []).includes(col.data_type)) {
        problems.push(`${table}.${f.name}: expected ${f.type} (${SCALAR_TO_PG[f.type]}), found ${col.data_type}`);
      }
      const dbNullable = col.is_nullable === 'YES';
      if (dbNullable === f.isRequired) {
        problems.push(`${table}.${f.name}: schema says ${f.isRequired ? 'required' : 'optional'}, DB column is ${dbNullable ? 'nullable' : 'NOT NULL'}`);
      }
      byName.delete(f.dbName ?? f.name);
    }
    for (const leftover of byName.keys()) problems.push(`${table}.${leftover}: column exists in DB but not in schema.prisma`);

    // Unique constraints (single + composite) incl. primary key
    const { rows: idx } = await db.query(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE c.relname = $1 AND i.indisunique
        GROUP BY i.indexrelid`,
      [table],
    );
    const dbUniques = new Set(idx.map((r) => [...r.cols].sort().join(',')));
    const wanted = [];
    if (model.primaryKey) wanted.push(model.primaryKey.fields);
    else wanted.push(model.fields.filter((f) => f.isId).map((f) => f.name));
    for (const u of model.uniqueFields) wanted.push(u);
    for (const f of model.fields) if (f.isUnique) wanted.push([f.name]);
    for (const fields of wanted) {
      const key = [...fields].sort().join(',');
      if (!dbUniques.has(key)) problems.push(`${table}: missing unique/primary index on (${fields.join(', ')})`);
    }

    // Foreign keys
    for (const f of model.fields.filter((x) => x.kind === 'object' && x.relationFromFields?.length)) {
      const target = models.find((m) => m.name === f.type);
      const { rows: fks } = await db.query(
        `SELECT pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          WHERE con.contype = 'f' AND c.relname = $1`,
        [table],
      );
      const cols = f.relationFromFields.join('", "');
      const refTable = target.dbName ?? target.name;
      const expectedDelete = ON_DELETE[f.relationOnDelete ?? (f.isRequired ? 'Restrict' : 'SetNull')];
      const match = fks.find((r) => r.def.includes(`FOREIGN KEY ("${cols}")`) && r.def.includes(`REFERENCES ${refTable}(`));
      if (!match) problems.push(`${table}: missing foreign key (${f.relationFromFields.join(', ')}) -> ${refTable}`);
      else if (expectedDelete && !match.def.includes(`ON DELETE ${expectedDelete}`) && !(expectedDelete === 'NO ACTION' && !match.def.includes('ON DELETE'))) {
        problems.push(`${table}: FK (${f.relationFromFields.join(', ')}) expected ON DELETE ${expectedDelete}, got: ${match.def}`);
      }
    }
  }

  // Enum values
  for (const e of enums) {
    const { rows } = await db.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [e.name],
    );
    const dbVals = rows.map((r) => r.enumlabel);
    const schemaVals = e.values.map((v) => v.name);
    for (const v of schemaVals) if (!dbVals.includes(v)) problems.push(`enum ${e.name}: DB is missing value ${v}`);
    for (const v of dbVals) if (!schemaVals.includes(v)) problems.push(`enum ${e.name}: DB has extra value ${v}`);
  }
  await db.end();

  if (problems.length) {
    console.error(`Schema drift detected (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK: ${models.length} models, ${enums.length} enums match the database.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

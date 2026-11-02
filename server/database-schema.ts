import type { BuildModule, Evidence, Snapshot } from '../shared/model.js';
import {
  compareSchemas,
  compareMigrationPaths,
  type DatabaseSchema,
  type SchemaMigration,
  type SchemaTable,
} from '../shared/database-schema.js';
import { readSource } from './repository.js';
import { projectModules } from './contract-builds.js';
import { t } from '../shared/i18n.js';

const ident =
  '(?:"(?:[^"]|"")+"|`[^`]+`|[a-zA-Z_][\\w$]*)(?:\\s*\\.\\s*(?:"(?:[^"]|"")+"|`[^`]+`|[a-zA-Z_][\\w$]*))?';
const nameOf = (text: string) =>
  text
    .trim()
    .split(/\s*\.\s*/)
    .map((part) =>
      part.startsWith('"') || part.startsWith('`')
        ? part.slice(1, -1).replace(/""/g, '"')
        : part.toLowerCase(),
    )
    .join('.');
// Preserve offsets while masking comments; quoted strings/dollar bodies are not comments.
function cleanSql(text: string) {
  let result = '',
    quote = '',
    dollar = '',
    block = 0,
    line = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (line) {
      result += c === '\n' ? '\n' : ' ';
      if (c === '\n') line = false;
      continue;
    }
    if (block) {
      if (c === '/' && next === '*') {
        block++;
        result += '  ';
        i++;
      } else if (c === '*' && next === '/') {
        block--;
        result += '  ';
        i++;
      } else result += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        result += dollar;
        i += dollar.length - 1;
        dollar = '';
      } else result += c;
      continue;
    }
    if (quote) {
      result += c;
      if (c === quote) {
        if (next === quote) {
          result += next;
          i++;
        } else quote = '';
      }
      continue;
    }
    if (c === '-' && next === '-') {
      line = true;
      result += '  ';
      i++;
    } else if (c === '/' && next === '*') {
      block = 1;
      result += '  ';
      i++;
    } else {
      const tag = c === '$' ? text.slice(i).match(/^\$\w*\$/)?.[0] : undefined;
      if (tag) {
        dollar = tag;
        result += tag;
        i += tag.length - 1;
      } else {
        result += c;
        if ('\'"`'.includes(c)) quote = c;
      }
    }
  }
  return result;
}
function chunks(text: string, delimiter: string) {
  const result: { text: string; start: number; end: number }[] = [];
  let start = 0,
    depth = 0,
    quote = '',
    dollar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = '';
      }
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) i++;
        else quote = '';
      }
      continue;
    }
    const tag = c === '$' ? text.slice(i).match(/^\$\w*\$/)?.[0] : undefined;
    if (tag) {
      dollar = tag;
      i += tag.length - 1;
      continue;
    }
    if ('\'"`'.includes(c)) {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === delimiter && depth === 0) {
      result.push({ text: text.slice(start, i), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) result.push({ text: text.slice(start), start, end: text.length });
  return result;
}
const names = (text: string) => chunks(text, ',').map((item) => nameOf(item.text));
function addDefinition(table: SchemaTable, raw: string) {
  let definition = raw.trim();
  const constraint = definition.match(new RegExp(`^CONSTRAINT\\s+(${ident})\\s+`, 'i'));
  if (constraint) definition = definition.slice(constraint[0].length);
  const key = definition.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  if (key) {
    table.indexes.push({
      name: constraint ? nameOf(constraint[1]) : 'PRIMARY KEY',
      definition: `PRIMARY KEY (${key[1]})`,
      unique: true,
      primary: true,
    });
    for (const column of table.columns)
      if (names(key[1]).includes(column.name)) {
        column.primary = true;
        column.nullable = false;
      }
    return true;
  }
  const fk = definition.match(
    new RegExp(
      `^FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+(${ident})\\s*(?:\\(([^)]+)\\))?`,
      'i',
    ),
  );
  if (fk) {
    table.foreignKeys.push({
      name: constraint ? nameOf(constraint[1]) : `fk:${fk[1]}`,
      columns: names(fk[1]),
      target: nameOf(fk[2]),
      targetColumns: fk[3] ? names(fk[3]) : [],
    });
    return true;
  }
  const unique = definition.match(/^UNIQUE\s*\(([^)]+)\)/i);
  if (unique) {
    table.indexes.push({
      name: constraint ? nameOf(constraint[1]) : `unique:${unique[1]}`,
      definition: raw.trim(),
      unique: true,
    });
    return true;
  }
  if (/^CHECK\b/i.test(definition)) {
    (table.constraints ??= []).push(raw.trim());
    return true;
  }
  const column = definition.match(new RegExp(`^(${ident})\\s+([\\s\\S]+)$`));
  if (!column) return false;
  const name = nameOf(column[1]),
    rest = column[2].trim();
  const primary = /\bPRIMARY\s+KEY\b/i.test(rest);
  table.columns.push({
    name,
    type: rest.split(
      /\s+(?=NOT\s+NULL\b|NULL\b|DEFAULT\b|PRIMARY\s+KEY\b|UNIQUE\b|REFERENCES\b|CHECK\b|CONSTRAINT\b|GENERATED\b|COLLATE\b)/i,
    )[0],
    definition: rest,
    primary,
    nullable: !primary && !/\bNOT\s+NULL\b/i.test(rest),
  });
  if (primary)
    table.indexes.push({
      name: 'PRIMARY KEY',
      definition: `PRIMARY KEY (${name})`,
      unique: true,
      primary: true,
    });
  if (/\bUNIQUE\b/i.test(rest))
    table.indexes.push({ name: `unique:${name}`, definition: `UNIQUE (${name})`, unique: true });
  const reference = rest.match(
    new RegExp(`\\bREFERENCES\\s+(${ident})\\s*(?:\\(([^)]+)\\))?`, 'i'),
  );
  if (reference)
    table.foreignKeys.push({
      name: `fk:${name}`,
      columns: [name],
      target: nameOf(reference[1]),
      targetColumns: reference[2] ? names(reference[2]) : [],
    });
  return true;
}

export function extractDdl(
  files: { path: string; text: string }[],
  repoId: string,
  side: 'base' | 'head',
) {
  const tables = new Map<string, SchemaTable>(),
    warnings: string[] = [],
    effects: SchemaMigration['effects'] = [],
    touched: { name: string; evidence: Evidence }[] = [];
  for (const file of [...files].sort((a, b) => compareMigrationPaths(a.path, b.path))) {
    const cleaned = cleanSql(file.text);
    for (const statement of chunks(cleaned, ';')) {
      const sql = statement.text.trim();
      if (!sql) continue;
      const raw = file.text.slice(statement.start, statement.end).trim();
      const evidence: Evidence = {
        repoId,
        side,
        path: file.path,
        startLine: file.text.slice(0, statement.start).split('\n').length,
        endLine: file.text.slice(0, statement.end).split('\n').length,
      };
      const record = (table: SchemaTable) => {
        table.ddl.push(raw);
        table.evidence.push(evidence);
        touched.push({ name: table.name, evidence });
        effects.push({ table: table.name, kind: 'structure', evidence });
      };
      const create = sql.match(
        new RegExp(
          `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})\\s*\\(([\\s\\S]*)\\)\\s*$`,
          'i',
        ),
      );
      if (create) {
        const name = nameOf(create[1]);
        if (tables.has(name)) {
          effects.push({ table: name, kind: 'structure', evidence });
          if (!/IF\s+NOT\s+EXISTS/i.test(sql))
            warnings.push(t('{0}: repeated CREATE TABLE {1}.', file.path, name));
          continue;
        }
        const table: SchemaTable = {
          name,
          columns: [],
          indexes: [],
          foreignKeys: [],
          ddl: [],
          evidence: [],
        };
        for (const item of chunks(create[2], ','))
          if (!addDefinition(table, item.text))
            warnings.push(
              t('{0}: definition {1} was not parsed.', name, item.text.trim().slice(0, 70)),
            );
        // Table-level keys can precede column definitions.
        for (const item of chunks(create[2], ',')) {
          const key = item.text.match(/(?:^|\s)PRIMARY\s+KEY\s*\(([^)]+)\)/i);
          if (key)
            table.columns.forEach((column) => {
              if (names(key[1]).includes(column.name)) {
                column.primary = true;
                column.nullable = false;
              }
            });
        }
        tables.set(name, table);
        record(table);
        continue;
      }
      const index = sql.match(
        new RegExp(
          `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})\\s+ON\\s+(?:ONLY\\s+)?(${ident})\\s+([\\s\\S]+)$`,
          'i',
        ),
      );
      if (index) {
        const table = tables.get(nameOf(index[3]));
        if (table) {
          table.indexes.push({
            name: nameOf(index[2]),
            unique: !!index[1],
            definition: index[4].trim(),
          });
          record(table);
        } else {
          effects.push({ table: nameOf(index[3]), kind: 'structure', evidence });
          warnings.push(
            t('{0}: the table of index {1} is missing in the available DDL.', file.path, index[2]),
          );
        }
        continue;
      }
      const drop = sql.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${ident})`, 'i'));
      if (drop) {
        touched.push({ name: nameOf(drop[1]), evidence });
        effects.push({ table: nameOf(drop[1]), kind: 'structure', evidence });
        tables.delete(nameOf(drop[1]));
        continue;
      }
      const dropIndex = sql.match(
        new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ident})`, 'i'),
      );
      if (dropIndex) {
        for (const table of tables.values())
          if (table.indexes.some((item) => item.name === nameOf(dropIndex[1]))) {
            table.indexes = table.indexes.filter((item) => item.name !== nameOf(dropIndex[1]));
            record(table);
          }
        continue;
      }
      const alter = sql.match(
        new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${ident})\\s+([\\s\\S]+)$`, 'i'),
      );
      if (alter) {
        const table = tables.get(nameOf(alter[1]));
        if (!table) {
          effects.push({ table: nameOf(alter[1]), kind: 'structure', evidence });
          warnings.push(
            t('{0}: ALTER TABLE {1} without the original CREATE TABLE.', file.path, alter[1]),
          );
          continue;
        }
        record(table);
        for (const item of chunks(alter[2], ',')) {
          const action = item.text.trim();
          const add = action.match(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i);
          if (add && addDefinition(table, add[1])) continue;
          const remove = action.match(
            new RegExp(`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?(${ident})`, 'i'),
          );
          if (remove) {
            table.columns = table.columns.filter((column) => column.name !== nameOf(remove[1]));
            continue;
          }
          const dropConstraint = action.match(
            new RegExp(`^DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${ident})`, 'i'),
          );
          if (dropConstraint) {
            table.foreignKeys = table.foreignKeys.filter(
              (key) => key.name !== nameOf(dropConstraint[1]),
            );
            table.indexes = table.indexes.filter((key) => key.name !== nameOf(dropConstraint[1]));
            continue;
          }
          const columnChange = action.match(
            new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${ident})\\s+([\\s\\S]+)$`, 'i'),
          );
          if (columnChange) {
            const column = table.columns.find((column) => column.name === nameOf(columnChange[1])),
              change = columnChange[2];
            if (column) {
              if (/^(?:SET\s+DATA\s+)?TYPE\s+/i.test(change)) {
                column.type = change
                  .replace(/^(?:SET\s+DATA\s+)?TYPE\s+/i, '')
                  .split(/\s+USING\b/i)[0];
                column.definition = column.definition.replace(
                  /^.*?(?=\s+(?:NOT\s+NULL|DEFAULT|PRIMARY|UNIQUE|REFERENCES|CHECK)\b|$)/i,
                  column.type,
                );
                continue;
              }
              if (/^(?:SET|DROP)\s+NOT\s+NULL$/i.test(change)) {
                column.nullable = /^DROP/i.test(change);
                column.definition =
                  column.definition.replace(/\s*NOT\s+NULL\b/i, '') +
                  (column.nullable ? '' : ' NOT NULL');
                continue;
              }
              if (/^(?:SET|DROP)\s+DEFAULT\b/i.test(change)) {
                column.definition =
                  column.definition.replace(/\s+DEFAULT\s+[\s\S]*$/i, '') +
                  (/^SET/i.test(change) ? ` ${change.slice(4)}` : '');
                continue;
              }
            }
          }
          warnings.push(
            t('{0}: DDL “{1}” was not parsed; check the source.', table.name, action.slice(0, 90)),
          );
        }
        continue;
      }
      const data = sql.match(
        new RegExp(`^(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?(${ident})`, 'i'),
      );
      if (data) {
        effects.push({ table: nameOf(data[1]), kind: 'data', evidence });
        continue;
      }
      const truncate = sql.match(/^TRUNCATE\s+(?:TABLE\s+)?([\s\S]+)$/i);
      if (truncate) {
        for (const part of chunks(
          truncate[1].replace(/\s+(?:RESTART|CONTINUE|CASCADE|RESTRICT)\b[\s\S]*$/i, ''),
          ',',
        )) {
          const target = part.text.trim().match(new RegExp(`^(?:ONLY\\s+)?(${ident})`, 'i'));
          if (target) effects.push({ table: nameOf(target[1]), kind: 'data', evidence });
        }
        continue;
      }
      if (/^(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b/i.test(sql) || /^(?:DO|EXECUTE)\b/i.test(sql))
        warnings.push(
          t('{0}: unsupported DDL or dynamic SQL; the schema may be incomplete.', file.path),
        );
    }
  }
  for (const table of tables.values())
    for (const key of table.foreignKeys) {
      if (!key.target.includes('.') && table.name.includes('.'))
        key.target = `${table.name.slice(0, table.name.lastIndexOf('.'))}.${key.target}`;
      if (!key.targetColumns.length)
        key.targetColumns =
          tables
            .get(key.target)
            ?.columns.filter((column) => column.primary)
            .map((column) => column.name) ?? [];
    }
  return { tables: [...tables.values()], warnings: [...new Set(warnings)], touched, effects };
}
const schemaPaths = (paths: string[]) =>
  paths.filter(
    (path) =>
      /\.sql$/i.test(path) &&
      !/(?:^|\/)(?:test|tests|rollback|undo)(?:\/|$)|(?:^|\/)U\d/i.test(path),
  );

async function serviceSchema(snapshot: Snapshot): Promise<DatabaseSchema> {
  const build = async (side: 'base' | 'head') => {
    const paths = schemaPaths(side === 'head' ? snapshot.headFiles : snapshot.baseFiles);
    const migrations = paths.filter(
      (path) =>
        /migration|changelog|schema/i.test(path) ||
        /(?:^|\/)(?:V\d[\d._]*__|R__).+\.sql$/i.test(path),
    );
    const selected = migrations.length ? migrations : paths;
    const files = await Promise.all(
      selected.map(async (path) => ({ path, text: await readSource(snapshot, { side, path }) })),
    );
    return { ...extractDdl(files, snapshot.repoId, side), files };
  };
  const [before, after] = await Promise.all([build('base'), build('head')]);
  const migrations: SchemaMigration[] = [
    ...new Set([...before.files, ...after.files].map((file) => file.path)),
  ]
    .sort(compareMigrationPaths)
    .map((path) => {
      const old = before.files.find((file) => file.path === path),
        next = after.files.find((file) => file.path === path),
        file = next ?? old!;
      const name = path.split('/').pop()!,
        version = name.match(/^V(\d+(?:[._]\d+)*)(?:__|\.sql$)/i)?.[1];
      const side = next ? 'head' : 'base';
      return {
        path,
        name,
        kind: version ? 'versioned' : /^R__/i.test(name) ? 'repeatable' : 'sql',
        ...(version ? { version } : {}),
        change: !old
          ? 'added'
          : !next
            ? 'removed'
            : old.text === next.text
              ? 'unchanged'
              : 'modified',
        evidence: {
          repoId: snapshot.repoId,
          side,
          path,
          startLine: 1,
          endLine: file.text.split('\n').length,
        },
        effects: [
          ...(next ? after : before).effects,
          ...(old && next && old.text !== next.text ? before.effects : []),
        ].filter((effect) => effect.evidence.path === path),
      };
    });
  return {
    snapshotId: snapshot.id,
    repoId: snapshot.repoId,
    repoName: snapshot.repoName,
    headSha: snapshot.headSha,
    baseSha: snapshot.mergeBase,
    tables: compareSchemas(before.tables, after.tables).map((table) => ({
      ...table,
      changeEvidence: after.touched
        .filter((item) => item.name === table.name)
        .map((item) => item.evidence),
    })),
    warnings: [
      ...before.warnings.map((warning) => t('Before the PR: {0}', warning)),
      ...after.warnings,
    ],
    migrations,
  };
}

function serviceOwner(path: string, modules: BuildModule[], repoName: string) {
  const module = modules
    .filter((m) => !m.dir || path.startsWith(m.dir + '/'))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  // Infrastructure SQL and applications without their own build file still have an explicit
  // source directory. A root aggregator must not swallow these service boundaries.
  const resource = path.match(/^(.*?)\/src\/(?:main|test)\/resources\//)?.[1];
  const collection = path.match(
    /^(.*?(?:^|\/)(?:apps|services|infra|modules)\/[^/]+)(?:\/|$)/,
  )?.[1];
  const inferred = resource ?? collection;
  const dir = module?.dir || inferred || '';
  const name =
    module?.dir && module.tool !== 'gradle' && !module.name.includes('${')
      ? module.name
      : dir
        ? dir.split('/').at(-1)!
        : repoName;
  return { dir, name };
}

/** Parse independent module trees separately: equal table names in two services never merge. */
export async function databaseSchema(snapshot: Snapshot): Promise<DatabaseSchema> {
  const paths = [...new Set(schemaPaths([...snapshot.baseFiles, ...snapshot.headFiles]))];
  if (!paths.length) return serviceSchema(snapshot);
  const modules = await projectModules(snapshot);
  const groups = new Map<string, { dir: string; name: string; paths: Set<string> }>();
  for (const path of paths) {
    const owner = serviceOwner(path, modules, snapshot.repoName);
    const group = groups.get(owner.dir) ?? { ...owner, paths: new Set<string>() };
    group.paths.add(path);
    groups.set(owner.dir, group);
  }
  const services = await Promise.all(
    [...groups.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (group) => ({
        ...(await serviceSchema({
          ...snapshot,
          headFiles: snapshot.headFiles.filter((p) => group.paths.has(p)),
          baseFiles: snapshot.baseFiles.filter((p) => group.paths.has(p)),
        })),
        serviceId: group.dir
          ? `${snapshot.repoId}:${encodeURIComponent(group.dir)}`
          : snapshot.repoId,
        serviceName: !group.dir && groups.size > 1 ? t('Shared SQL scripts') : group.name,
        serviceDir: group.dir,
      })),
  );
  if (services.length === 1) return services[0];
  return {
    snapshotId: snapshot.id,
    repoId: snapshot.repoId,
    repoName: snapshot.repoName,
    headSha: snapshot.headSha,
    baseSha: snapshot.mergeBase,
    tables: [],
    warnings: [],
    migrations: services.flatMap((s) => s.migrations ?? []),
    services,
  };
}

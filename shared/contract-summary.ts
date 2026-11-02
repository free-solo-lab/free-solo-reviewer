import type { Contract } from './model.js';
import { t, tc } from './i18n.js';
/** Small structural fallback. Model-written change cards remain the preferred explanation. */
const tokens = (text: string) =>
  [
    ...text.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\d+|[^\s]/g,
    ),
  ]
    .map((m) => m[0])
    .filter((t) => !/^(\/\/|\/\*|#)/.test(t));
const identifier = (value = '') => /^[A-Za-z_]\w*$/.test(value);
interface Definition {
  kind: string;
  body: string[];
}
function definitions(text: string) {
  const parts = tokens(text),
    result = new Map<string, Definition>();
  for (let i = 0; i < parts.length; i++) {
    if (
      ![
        'enum',
        'struct',
        'union',
        'exception',
        'service',
        'message',
        'type',
        'input',
        'interface',
      ].includes(parts[i]) ||
      !identifier(parts[i + 1])
    )
      continue;
    const kind = parts[i],
      name = parts[++i];
    let start = i + 1;
    while (start < parts.length && parts[start] !== '{' && parts[start] !== ';') start++;
    if (parts[start] !== '{') continue;
    let end = start + 1,
      depth = 1;
    while (end < parts.length && depth) {
      if (parts[end] === '{') depth++;
      if (parts[end] === '}') depth--;
      end++;
    }
    if (!depth) result.set(name, { kind, body: parts.slice(start + 1, end - 1) });
  }
  return result;
}
function fields(body: string[], format: Contract['format']) {
  const result = new Map<string, { name: string; type: string; mode: string }>();
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      let depth = 1;
      while (++i < body.length && depth) {
        if (body[i] === '{') depth++;
        if (body[i] === '}') depth--;
      }
      continue;
    }
    let tag: string | undefined,
      at = i;
    if (format === 'thrift') {
      if (!/^\d+$/.test(body[at]) || body[at + 1] !== ':') continue;
      tag = body[at];
      at += 2;
    }
    const mode = ['optional', 'required', 'repeated'].includes(body[at]) ? body[at++] : '';
    if (!identifier(body[at])) continue;
    const type: string[] = [body[at++]];
    while (body[at] === '.' && identifier(body[at + 1])) type.push(body[at++], body[at++]);
    if (body[at] === '<') {
      let depth = 0;
      do {
        const token = body[at++];
        type.push(token);
        if (token === '<') depth++;
        if (token === '>') depth--;
      } while (at < body.length && depth);
    }
    const name = body[at++];
    if (!identifier(name)) continue;
    if (format === 'protobuf') {
      if (body[at] !== '=' || !/^\d+$/.test(body[at + 1])) continue;
      tag = body[at + 1];
    }
    if (tag) {
      result.set(tag, { name, type: type.join(''), mode });
      i = format === 'protobuf' ? at + 1 : at - 1;
    }
  }
  return result;
}
const list = (names: string[]) =>
  names.slice(0, 5).join(', ') + (names.length > 5 ? t(' and {0} more', names.length - 5) : '');
export function contractSourceSummary(
  format: Contract['format'],
  before: string | null,
  after: string | null,
): string[] {
  if (before === null) {
    if (format === 'antlr')
      return [t('Added a language description and expression parsing rules.')];
    const names = [...definitions(after ?? '').keys()];
    return [
      t('Added a new contract{0}.', names.length ? t(' with definitions {0}', list(names)) : ''),
    ];
  }
  if (after === null)
    return [
      t(
        'Contract removed: its models and operations are no longer defined in this file. Check the clients that use it.',
      ),
    ];
  if (tokens(before).join(' ') === tokens(after).join(' '))
    return [t('Contract comments or formatting refined; API and model definitions are unchanged.')];
  const previous = definitions(before),
    current = definitions(after),
    summary: string[] = [];
  const addedModels: string[] = [],
    removedModels: string[] = [];
  const addedFields = new Map<string, { owners: Set<string>; mode: string; names: Set<string> }>();
  for (const [name, definition] of current) {
    const old = previous.get(name);
    if (definition.kind === 'enum') {
      const values = (body: string[]) =>
        body.filter(
          (t, i) =>
            identifier(t) &&
            (format === 'graphql' ||
              (body[i + 1] === '=' &&
                (/^\d+$/.test(body[i + 2] ?? '') ||
                  (body[i + 2] === '-' && /^\d+$/.test(body[i + 3] ?? '')))) ||
              (format === 'thrift' && (i === 0 || [',', ';'].includes(body[i - 1])))),
        );
      const added = values(definition.body).filter((v) => !old || !values(old.body).includes(v));
      const removed = old
        ? values(old.body).filter((v) => !values(definition.body).includes(v))
        : [];
      if (!old)
        summary.push(
          t('Added enum {0}{1}.', name, added.length ? t(' with values {0}', list(added)) : ''),
        );
      else if (added.length || removed.length)
        summary.push(
          t(
            'Updated the values of {0}: {1}.',
            name,
            [
              added.length ? t('added {0}', list(added)) : '',
              removed.length ? t('removed {0}', list(removed)) : '',
            ]
              .filter(Boolean)
              .join('; '),
          ),
        );
      else if (old.body.join(' ') !== definition.body.join(' '))
        summary.push(
          t('Changed the values or settings of enum {0}; check client compatibility.', name),
        );
      continue;
    }
    if (!old) {
      addedModels.push(name);
      continue;
    }
    if (old.body.join(' ') === definition.body.join(' ')) continue;
    if (['service', 'interface'].includes(definition.kind)) {
      summary.push(t('Changed the available operations or their parameters in API {0}.', name));
      continue;
    }
    if (format !== 'thrift' && format !== 'protobuf') {
      summary.push(t('Updated data structure {0}.', name));
      continue;
    }
    const beforeFields = fields(old.body, format),
      afterFields = fields(definition.body, format),
      changed: string[] = [],
      removed: string[] = [];
    for (const [tag, field] of afterFields) {
      const previous = beforeFields.get(tag);
      if (!previous) {
        const key = name + ':' + field.mode;
        if (!addedFields.has(key))
          addedFields.set(key, { owners: new Set(), mode: field.mode, names: new Set() });
        addedFields.get(key)!.owners.add(name);
        addedFields.get(key)!.names.add(field.name);
      } else if (JSON.stringify(previous) !== JSON.stringify(field)) changed.push(field.name);
    }
    for (const [tag, field] of beforeFields) if (!afterFields.has(tag)) removed.push(field.name);
    if (changed.length)
      summary.push(
        t('Changed field types, names or requiredness in model {0}: {1}.', name, list(changed)),
      );
    if (removed.length)
      summary.push(
        t(
          'Removed fields {1} from model {0}; check the clients that use them.',
          name,
          list(removed),
        ),
      );
    if (
      !changed.length &&
      !removed.length &&
      [...afterFields.keys()].every((k) => beforeFields.has(k))
    )
      summary.push(t('Updated definitions or default values in model {0}.', name));
  }
  for (const name of previous.keys()) if (!current.has(name)) removedModels.push(name);
  if (addedModels.length)
    summary.push(t('Added definitions to the contract: {0}.', list(addedModels)));
  if (removedModels.length)
    summary.push(
      t(
        'Removed definitions from the contract: {0}; check client compatibility.',
        list(removedModels),
      ),
    );
  for (const group of addedFields.values())
    summary.push(
      t(
        'Models {0} gained {1} fields: {2}.{3}',
        list([...group.owners]),
        tc(
          'field mode',
          group.mode === 'optional' || group.mode === 'repeated' || group.mode === 'required'
            ? group.mode
            : 'new',
        ),
        list([...group.names]),
        group.mode === 'optional' ? t(' This data may be omitted.') : '',
      ),
    );
  return summary.length
    ? summary
    : [
        format === 'antlr'
          ? t(
              'Language rules changed: the set of recognized expressions is updated. See the diff for details.',
            )
          : t('Contract definitions and settings updated. See the diff for details.'),
      ];
}

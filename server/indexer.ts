import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { readSource } from './repository.js';
import { indexKey, type Store } from './store.js';
import type {
  Snapshot,
  Side,
  SourceIndex,
  IndexedMethod,
  IndexedCall,
  IndexedType,
  ProgrammaticTransaction,
} from '../shared/model.js';
import { t } from '../shared/i18n.js';
const require = createRequire(import.meta.url);
let languages: Promise<{ java: Parser.Language; kotlin: Parser.Language }> | undefined;
function loadLanguages() {
  return (languages ??= (async () => {
    await Parser.init();
    const java = await Parser.Language.load(
      require.resolve('tree-sitter-wasms/out/tree-sitter-java.wasm'),
    );
    const kotlin = await Parser.Language.load(
      require.resolve('tree-sitter-wasms/out/tree-sitter-kotlin.wasm'),
    );
    return { java, kotlin };
  })());
}
export const INDEX_VERSION = 'type-navigation-2';
const typeNodes = new Set([
  'class_declaration',
  'interface_declaration',
  'object_declaration',
  'enum_declaration',
  'record_declaration',
]);
function extractTypes(
  root: Parser.SyntaxNode,
  repoId: string,
  side: Side,
  path: string,
): IndexedType[] {
  const all = descendants(root);
  const pkg =
    all
      .find((n) => ['package_declaration', 'package_header'].includes(n.type))
      ?.text.replace(/^package\s+|;$/g, '')
      .trim() ?? '';
  const imports = all
    .filter((n) => ['import_declaration', 'import_header'].includes(n.type))
    .map((n) => n.text.replace(/^import\s+|;$/g, '').trim());
  return all
    .filter((n) => typeNodes.has(n.type))
    .map((node) => {
      const nameOf = (n: Parser.SyntaxNode) =>
        n.childForFieldName('name')?.text ??
        n.namedChildren.find((c) => ['type_identifier', 'identifier'].includes(c.type))?.text ??
        '';
      const owners: string[] = [nameOf(node)];
      for (let p = node.parent; p; p = p.parent)
        if (typeNodes.has(p.type)) owners.unshift(nameOf(p));
      const parents = node.namedChildren
        .filter((n) =>
          ['superclass', 'super_interfaces', 'extends_interfaces', 'delegation_specifier'].includes(
            n.type,
          ),
        )
        .flatMap((n) => {
          const types = descendants(n).filter(
            (c) =>
              ['type_identifier', 'scoped_type_identifier', 'user_type'].includes(c.type) &&
              ![
                'type_identifier',
                'scoped_type_identifier',
                'user_type',
                'type_arguments',
              ].includes(c.parent?.type ?? ''),
          );
          return types.map((c) => c.text.replace(/<.*>/g, '').trim());
        });
      return {
        name: nameOf(node),
        qualifiedName: [pkg, ...owners].filter(Boolean).join('.'),
        kind: node.children.some((c) => c.text === 'interface') ? 'interface' : 'class',
        parents,
        imports,
        evidence: {
          repoId,
          side,
          path,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        },
      };
    });
}
const transactionApis = new Set([
  'transaction',
  'transactionResult',
  'transactionAsync',
  'transactionResultAsync',
  'transactionPublisher',
]);
const methodTypes = new Set([
  'method_declaration',
  'constructor_declaration',
  'function_declaration',
]);
function descendants(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(descendants)];
}
function callable(node: Parser.SyntaxNode) {
  if (node.type === 'method_invocation')
    return {
      name: node.childForFieldName('name')?.text ?? '',
      receiver: node.childForFieldName('object')?.text ?? '',
      args: node.childForFieldName('arguments'),
    };
  if (node.type !== 'call_expression') return null;
  const target = node.namedChildren[0];
  if (!target) return null;
  const suffix = target.namedChildren.at(-1);
  return {
    name:
      target.type === 'navigation_expression'
        ? (suffix?.text.replace(/^[?.]+/, '') ?? '')
        : target.text,
    receiver:
      target.type === 'navigation_expression'
        ? target.text
            .slice(0, target.text.length - (suffix?.text.length ?? 0))
            .replace(/[?.]+$/, '')
        : '',
    args: node.namedChildren.find((n) => n.type === 'call_suffix') ?? null,
  };
}
function extractMethods(
  source: string,
  root: Parser.SyntaxNode,
  repoId: string,
  side: Side,
  path: string,
): IndexedMethod[] {
  const all = descendants(root);
  const dslNames = new Set<string>();
  const bindings = all
    .filter((n) =>
      [
        'formal_parameter',
        'parameter',
        'class_parameter',
        'field_declaration',
        'local_variable_declaration',
        'property_declaration',
      ].includes(n.type),
    )
    .flatMap((n) => {
      const declaration = n.namedChildren.find((c) => c.type === 'variable_declaration') ?? n;
      const type =
        declaration.childForFieldName('type')?.text ??
        declaration.namedChildren.find((c) => c.type === 'user_type' || c.type === 'nullable_type')
          ?.text;
      const names = n.namedChildren
        .filter((c) => c.type === 'variable_declarator')
        .map((c) => c.childForFieldName('name')?.text)
        .filter(Boolean);
      if (!names.length)
        names.push(
          declaration.childForFieldName('name')?.text ??
            declaration.namedChildren.find((c) => c.type === 'simple_identifier')?.text,
        );
      let scope = n.parent;
      while (scope && !methodTypes.has(scope.type) && !typeNodes.has(scope.type))
        scope = scope.parent;
      return type && scope
        ? names.filter(Boolean).map((name) => ({
            name,
            type: type.replace(/<.*>|\?/g, ''),
            scope: scope!.id,
            method: methodTypes.has(scope!.type),
          }))
        : [];
    });
  // Only declarations participate in receiver identification, never comments or strings.
  for (const node of all.filter((n) => /parameter|declaration$/.test(n.type))) {
    const header = node.text.split(/[={]/)[0];
    for (const m of header.matchAll(
      /\b(\w+)\s*:\s*(?:org\.jooq\.)?DSLContext\b|\b(?:org\.jooq\.)?DSLContext\s+(\w+)/g,
    ))
      dslNames.add(m[1] ?? m[2]);
  }
  const evidence = (node: Parser.SyntaxNode) => ({
    repoId,
    side,
    path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
  return all
    .filter((n) => methodTypes.has(n.type))
    .map((node) => {
      const name =
        node.childForFieldName('name')?.text ??
        node.namedChildren.find((c) => ['simple_identifier', 'identifier'].includes(c.type))
          ?.text ??
        '<anonymous>';
      const body =
        node.childForFieldName('body') ??
        node.namedChildren.find((c) =>
          ['function_body', 'block', 'constructor_body'].includes(c.type),
        );
      const header = source.slice(
        node.startIndex,
        body?.startIndex ?? Math.min(node.endIndex, node.startIndex + 500),
      );
      const callSites: IndexedCall[] = [];
      const programmaticTransactions: ProgrammaticTransaction[] = [];
      const visit = (current: Parser.SyntaxNode, scopes: string[], configurations: string[]) => {
        if (current.id !== node.id && methodTypes.has(current.type)) return;
        const call = callable(current);
        let block: Parser.SyntaxNode | undefined;
        let id: string | undefined;
        let configuration: string | undefined;
        if (call) {
          const receiver = call.receiver.replace(/\s+/g, '');
          const plain = receiver.replace(/^this\./, '');
          const derived = configurations.some(
            (c) =>
              receiver === `${c}.dsl()` ||
              new RegExp(`^(?:DSL\\.)?using\\(${c}\\)$`).test(receiver),
          );
          const database = dslNames.has(plain) || derived;
          if (database && transactionApis.has(call.name)) {
            // The callback must be an argument of this call, not of a nested invocation.
            const findLambda = (n: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
              if (['lambda_literal', 'lambda_expression'].includes(n.type)) return n;
              if (n.type === 'call_expression' || n.type === 'method_invocation') return;
              for (const child of n.namedChildren) {
                const found = findLambda(child);
                if (found) return found;
              }
            };
            block = call.args ? findLambda(call.args) : undefined;
            id = `${repoId}:${side}:${path}:${current.startIndex}`;
            const params =
              block?.childForFieldName('parameters') ??
              block?.namedChildren.find((n) => n.type === 'lambda_parameters');
            configuration = params?.text
              .replace(/[()]/g, '')
              .split(':')[0]
              .trim()
              .split(/\s+/)
              .at(-1);
            programmaticTransactions.push({
              id,
              api: call.name,
              evidence: evidence(block ?? current),
              callback: !!block,
              asynchronous: /Async$|Publisher$/.test(call.name),
              nested: scopes.length > 0,
            });
          }
          callSites.push({
            receiverType: (() => {
              const scopes = new Set<number>();
              for (let p: Parser.SyntaxNode | null = current; p; p = p.parent) scopes.add(p.id);
              return bindings
                .filter((b) => b.name === plain && scopes.has(b.scope))
                .sort((a, b) => Number(b.method) - Number(a.method))[0]?.type;
            })(),
            name: call.name,
            receiver: call.receiver,
            evidence: evidence(current),
            transactionIds: [...scopes],
            database,
          });
        }
        for (const child of current.namedChildren) {
          // Apply the scope only inside the lambda, including nested expressions.
          const enter =
            id && block && child.startIndex <= block.startIndex && child.endIndex >= block.endIndex;
          if (enter) {
            const enterLambda = (n: Parser.SyntaxNode) => {
              if (n.id === block!.id) {
                visit(
                  n,
                  [...scopes, id!],
                  configuration ? [...configurations, configuration] : configurations,
                );
                return;
              }
              for (const c of n.namedChildren) enterLambda(c);
            };
            enterLambda(child);
          } else visit(child, scopes, configurations);
        }
      };
      visit(node, [], []);
      // AST traversal is lexical; a fluent outer invocation starts before its nested receiver.
      return {
        name,
        signature: header.replace(/\s+/g, ' ').slice(0, 600),
        annotations: Array.from(header.matchAll(/@[\w.]+(?:\([^)]*\))?/g), (m) => m[0]),
        calls: [
          ...new Set(callSites.map((c) => [c.receiver, c.name].filter(Boolean).join('.'))),
        ].slice(0, 300),
        evidence: evidence(node),
        callSites,
        programmaticTransactions,
      };
    });
}
export async function indexSource(
  source: string,
  repoId: string,
  side: Side,
  path: string,
): Promise<SourceIndex> {
  const langs = await loadLanguages();
  const parser = new Parser();
  try {
    parser.setLanguage(path.endsWith('.java') ? langs.java : langs.kotlin);
    const tree = parser.parse(source);
    try {
      const types = extractTypes(tree.rootNode, repoId, side, path);
      const methods = extractMethods(source, tree.rootNode, repoId, side, path).map((method) => ({
        ...method,
        owner: types
          .filter(
            (t) =>
              t.evidence.startLine <= method.evidence.startLine &&
              t.evidence.endLine >= method.evidence.endLine,
          )
          .sort(
            (a, b) =>
              b.evidence.startLine - a.evidence.startLine ||
              a.evidence.endLine - b.evidence.endLine,
          )[0]?.qualifiedName,
      }));
      return {
        version: INDEX_VERSION,
        repoId,
        side,
        methods,
        types,
        errors: tree.rootNode.hasError() ? [t('{0}: partial syntax parse', path)] : [],
        filesIndexed: 1,
      };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
/** Each commit is indexed once; later reviews of it read the stored index. */
export async function storedIndex(
  store: Store,
  snapshot: Snapshot,
  side: Side,
  signal?: AbortSignal,
) {
  const key = indexKey(INDEX_VERSION, snapshot, side);
  const cached = store.index(key);
  if (cached) return { index: cached, cached: true };
  const index = await indexSnapshot(snapshot, side, signal);
  store.saveIndex(key, index);
  return { index, cached: false };
}
export async function indexSnapshot(
  snapshot: Snapshot,
  side: Side,
  signal?: AbortSignal,
): Promise<SourceIndex> {
  const result: SourceIndex = {
    version: INDEX_VERSION,
    repoId: snapshot.repoId,
    side,
    methods: [],
    types: [],
    errors: [],
    filesIndexed: 0,
  };
  for (const path of (side === 'head' ? snapshot.headFiles : snapshot.baseFiles).filter((p) =>
    /\.(java|kt)$/.test(p),
  )) {
    signal?.throwIfAborted();
    const index = await indexSource(
      await readSource(snapshot, { side, path }),
      snapshot.repoId,
      side,
      path,
    );
    result.methods.push(...index.methods);
    result.types!.push(...(index.types ?? []));
    result.errors.push(...index.errors);
    result.filesIndexed++;
  }
  return result;
}

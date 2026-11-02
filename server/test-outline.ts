import type { IndexedCall, IndexedMethod, ReviewTest } from '../shared/model.js';

type Step = ReviewTest['steps'][number];
const MAX_STEPS = 20;
const assertion =
  /^(assert\w*|verify\w*|expect\w*|should\w*|is[A-Z]\w*|has[A-Z]\w*|contains\w*|matches|check\w*|fail)$/;
const mock =
  /^(when|whenever|given|willReturn|willThrow|willAnswer|thenReturn|thenThrow|thenAnswer|doReturn|doThrow|doAnswer|doNothing|every|coEvery|mock|mockk|spy|spyk|stubFor|answers|returns|throws)$/;
const fixture =
  /^(builder|build|of|from|create\w*|random\w*|generate\w*|init\w*|new\w*|with\w*|set\w*)$/;

function kindOf(call: IndexedCall): Step['kind'] {
  const receiver = call.receiver.replace(/\s+/g, '');
  if (assertion.test(call.name) || /^(Assertions|Assert|assertThat\()/.test(receiver))
    return 'assertion';
  if (mock.test(call.name) || /^(Mockito|BDDMockito|given\(|when\(|every\{)/.test(receiver))
    return 'mock';
  return fixture.test(call.name) ? 'setup' : 'call';
}
const priority: Record<Step['kind'], number> = { assertion: 3, mock: 2, call: 1, setup: 0 };

/**
 * Steps of a test method straight from its call sites: one step per source line, labelled with
 * that line, so the model only has to name the test and say what it checks.
 */
export function testOutline(method: IndexedMethod, source: string[]): Step[] {
  const owner = method.evidence.path
    .split('/')
    .pop()!
    .replace(/\.\w+$/, '');
  const byLine = new Map<number, IndexedCall[]>();
  for (const call of method.callSites ?? []) {
    const line = call.evidence.startLine;
    if (line <= method.evidence.startLine || line > method.evidence.endLine) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), call]);
  }
  const steps: Step[] = [];
  let acted = false;
  for (const [line, calls] of [...byLine].sort(([a], [b]) => a - b)) {
    // The outermost invocation on a line spans the others, e.g. assertThat(x.f()).isTrue().
    const outer = calls.reduce((a, b) => (b.evidence.endLine > a.evidence.endLine ? b : a));
    // An assertion or a stub anywhere on the line decides; otherwise the outer call does, so
    // Order.builder().id(1).build() is setup even though id() alone looks like a call.
    const kinds = calls.map(kindOf);
    let kind = kinds.includes('assertion')
      ? 'assertion'
      : kinds.includes('mock')
        ? 'mock'
        : kindOf(outer);
    if (kind === 'setup' && acted) kind = 'call';
    if (kind === 'call') acted = true;
    const main = calls.find((call) => kindOf(call) === kind) ?? outer;
    const label = (source[line - 1] ?? '').trim().replace(/\s+/g, ' ');
    steps.push({
      id: `${method.name}.${steps.length + 1}`,
      from: owner,
      to: [main.receiver.replace(/\s+/g, ''), main.name].filter(Boolean).join('.').slice(-80),
      label: label.length > 160 ? `${label.slice(0, 157)}…` : label || main.name,
      kind,
      evidence: [{ ...method.evidence, startLine: line, endLine: outer.evidence.endLine }],
      data: [],
    });
  }
  if (steps.length <= MAX_STEPS) return steps;
  // Keep every assertion and mock; trim the plainest steps.
  const keep = new Set(
    [...steps]
      .sort((a, b) => priority[b.kind] - priority[a.kind])
      .slice(0, MAX_STEPS)
      .map((step) => step.id),
  );
  return steps.filter((step) => keep.has(step.id));
}

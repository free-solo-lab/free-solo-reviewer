import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { reviewMarkLabels, type ReviewMark } from '../shared/review-markers';
import { groupTests } from '../shared/test-groups';
import { SequenceCanvas } from './SequenceCanvas';
import { Icon } from './icons';
import { reviewTestMethods, missingTestMethods } from '../shared/test-coverage';
import type { Evidence, ReviewTest, Scenario, Snapshot, SourceIndex } from '../shared/model';
import { ViewSwitch, type ItemView } from './ui/ViewSwitch';
import { t } from '../shared/i18n';

const kinds = {
  setup: t('Preparation'),
  mock: t('Mock'),
  call: t('Call'),
  assertion: t('Assertion'),
};
const roles = {
  input: t('Input'),
  output: t('Result'),
  mock: t('Mock'),
  expected: t('Expected'),
  fixture: t('Fixture'),
};
const split = (text: string, length: number) =>
  text.match(new RegExp(`.{1,${length}}`, 'g'))?.slice(0, 2) ?? [text];

function TestSequence({
  test,
  indexes,
  onSource,
}: {
  test: ReviewTest;
  indexes: SourceIndex[];
  onSource: (ref: Evidence) => void;
}) {
  const participants = [...new Set(test.steps.flatMap((step) => [step.from, step.to]))];
  const x = (name: string) => 130 + participants.indexOf(name) * 230;
  const width = Math.max(760, participants.length * 230 + 100),
    height = 135 + test.steps.length * 125;
  const headers = participants.map((name) => {
    const className = name.trim().split('.').at(-1);
    const refs = [
      ...test.evidence,
      ...indexes
        .filter((index) =>
          test.evidence.some((ref) => ref.repoId === index.repoId && ref.side === index.side),
        )
        .flatMap((index) => index.methods.map((method) => method.evidence)),
    ].filter(
      (ref) =>
        ref.path
          .split('/')
          .pop()
          ?.replace(/\.(java|kt)$/, '') === className,
    );
    const unique = new Map(refs.map((ref) => [`${ref.repoId}:${ref.side}:${ref.path}`, ref]));
    const source =
      unique.size === 1 ? { ...[...unique.values()][0], startLine: 1, endLine: 1 } : undefined;
    return (
      <g
        key={name}
        className={source ? 'test-class-code-link' : undefined}
        role={source ? 'button' : undefined}
        tabIndex={source ? 0 : undefined}
        aria-label={source ? t('Open the whole code of class {0}', name) : undefined}
        onClick={source ? () => onSource(source) : undefined}
        onKeyDown={
          source
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSource(source);
                }
              }
            : undefined
        }
      >
        <title>{source ? t('{0} · open the whole class code', name) : name}</title>
        <rect x={x(name) - 96} y={16} width={192} height={48} rx={7} className="test-participant" />
        <text x={x(name)} y={38} textAnchor="middle" className="test-participant-name">
          {split(name, 27).map((line, index) => (
            <tspan key={index} x={x(name)} dy={index ? 14 : 0}>
              {line}
            </tspan>
          ))}
        </text>
      </g>
    );
  });
  return (
    <div className="test-sequence-scroll">
      <SequenceCanvas
        width={width}
        height={height}
        headerHeight={78}
        header={headers}
        topInset={16}
      >
        <svg
          className="sequence-body"
          width={width}
          height={height}
          role="img"
          aria-label={t('Steps of test {0}', test.title)}
        >
          <defs>
            {Object.keys(kinds).map((kind) => (
              <marker
                id={`test-arrow-${kind}`}
                key={kind}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={`test-arrow ${kind}`} />
              </marker>
            ))}
          </defs>
          {participants.map((name) => (
            <line
              key={name}
              x1={x(name)}
              x2={x(name)}
              y1={64}
              y2={height - 15}
              className="test-lifeline"
            />
          ))}
          {test.steps.map((step, index) => {
            const y = 135 + index * 125,
              from = x(step.from),
              to = x(step.to),
              self = from === to,
              center = self ? from + 80 : (from + to) / 2;
            return (
              <g
                key={step.id}
                className={`test-step ${step.kind}`}
                role="button"
                tabIndex={0}
                aria-label={`${kinds[step.kind]}: ${step.label}`}
                onClick={() => {
                  const ref = step.evidence[0] ?? test.evidence[0];
                  if (ref) onSource(ref);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    const ref = step.evidence[0] ?? test.evidence[0];
                    if (ref) onSource(ref);
                  }
                }}
              >
                <rect
                  x={Math.min(from, to) - 12}
                  y={y - 40}
                  width={self ? 205 : Math.abs(to - from) + 24}
                  height={112}
                  fill="transparent"
                />
                <text x={center} y={y - 24} textAnchor="middle" className="test-step-label">
                  {split(`${index + 1}. ${step.label}`, 48).map((line, i) => (
                    <tspan key={i} x={center} dy={i ? 14 : 0}>
                      {line}
                    </tspan>
                  ))}
                </text>
                <path
                  d={self ? `M ${from} ${y} h 130 v 22 H ${from}` : `M ${from} ${y} H ${to}`}
                  markerEnd={`url(#test-arrow-${step.kind})`}
                />
                <text
                  x={center}
                  y={y + (self ? 44 : 24)}
                  textAnchor="middle"
                  className="test-step-kind"
                >
                  {kinds[step.kind]}
                  {step.data.length
                    ? ` · ${step.data.length} ${step.data.length === 1 ? t('model / data set') : t('models / data sets')}`
                    : ''}
                </text>
                {!!step.data.length && (
                  <text
                    x={center}
                    y={y + (self ? 61 : 43)}
                    textAnchor="middle"
                    className="test-step-model"
                  >
                    {step.data
                      .map((data) => data.type || data.label)
                      .slice(0, 2)
                      .join(' · ')
                      .slice(0, 64)}
                  </text>
                )}
                <title>{t('Open the test code and leave a comment')}</title>
              </g>
            );
          })}
        </svg>
      </SequenceCanvas>
    </div>
  );
}

/** What the test does, step by step, with the data each step prepares or checks. */
function TestDescription({
  test,
  onSource,
}: {
  test: ReviewTest;
  onSource: (ref: Evidence) => void;
}) {
  return (
    <div className="test-description">
      <p className="test-short-summary">{test.summary}</p>
      {!!test.steps.length && (
        <ol className="test-steps">
          {test.steps.map((step) => {
            const ref = step.evidence[0] ?? test.evidence[0];
            return (
              <li key={step.id}>
                <div className="test-step-head">
                  <span className={`test-step-badge ${step.kind}`}>{kinds[step.kind]}</span>
                  {ref ? (
                    <button
                      className="text-button"
                      title={t('Open the step code')}
                      onClick={() => onSource(ref)}
                    >
                      {step.label}
                    </button>
                  ) : (
                    <span>{step.label}</span>
                  )}
                </div>
                {step.from !== step.to && (
                  <small className="test-step-route">
                    {step.from} → {step.to}
                  </small>
                )}
                {!!step.data.length && (
                  <ul className="test-step-data">
                    {step.data.map((data, index) => (
                      <li key={index}>
                        <span>{roles[data.role]}</span> {data.label}
                        {data.type && <small> · {data.type}</small>}
                        {data.value && <code>{data.value}</code>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function TestsView({
  tests,
  scenarios,
  indexes,
  snapshots,
  ready,
  running,
  canAnalyze,
  onAnalyze,
  onSource,
  revisionMarks,
  showingPrevious,
  onLatest,
  view,
  onView,
  code,
}: {
  /** A test is shown as its description, its code or its step diagram, like a scenario. */
  view: ItemView;
  onView: (view: ItemView) => void;
  code: (test: ReviewTest) => ReactNode;
  revisionMarks?: Map<string, ReviewMark>;
  showingPrevious?: boolean;
  onLatest?: () => void;
  tests: ReviewTest[];
  scenarios: Scenario[];
  indexes: SourceIndex[];
  snapshots: Snapshot[];
  ready: boolean;
  running: boolean;
  canAnalyze: boolean;
  onAnalyze: () => Promise<void>;
  onSource: (ref: Evidence) => void;
}) {
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  // Both walk the call graph; typing in the search must not repeat them.
  const total = useMemo(() => reviewTestMethods(snapshots, indexes).length, [snapshots, indexes]);
  const missing = useMemo(
    () => missingTestMethods(snapshots, indexes, tests).length,
    [snapshots, indexes, tests],
  );
  const key = snapshots.map((snapshot) => snapshot.id).join(',');
  useEffect(() => {
    setSelected('');
    setError('');
    setRepo('all');
    setSearch('');
    setExpanded(new Set());
  }, [key]);
  const groups = useMemo(
    () =>
      groupTests(
        tests.filter((test) => repo === 'all' || test.evidence.some((ref) => ref.repoId === repo)),
        scenarios,
        indexes,
      )
        .map((group) => ({
          ...group,
          tests: group.tests
            .filter((test) =>
              `${group.title} ${test.title} ${test.summary} ${test.method} ${test.evidence.map((ref) => ref.path).join(' ')}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .sort(
              (a, b) =>
                Number(revisionMarks?.has(b.id) ?? false) -
                Number(revisionMarks?.has(a.id) ?? false),
            ),
        }))
        .filter((group) => group.tests.length)
        .sort(
          (a, b) =>
            Number(b.tests.some((test) => revisionMarks?.has(test.id))) -
            Number(a.tests.some((test) => revisionMarks?.has(test.id))),
        ),
    [tests, scenarios, indexes, repo, search, revisionMarks],
  );
  const isCollapsed = (id: string) => !expanded.has(id);
  const visible = groups.filter((group) => !isCollapsed(group.id)).flatMap((group) => group.tests);
  const current = visible.find((test) => test.id === selected) ?? visible[0];
  const activeGroup = groups.find((group) => group.tests.some((test) => test.id === current?.id));
  const nextGroup = groups[groups.findIndex((group) => group.id === activeGroup?.id) + 1];
  const goToGroup = (id: string, closeCurrent = false) => {
    const group = groups.find((item) => item.id === id);
    if (!group) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (closeCurrent && activeGroup) next.delete(activeGroup.id);
      next.add(id);
      return next;
    });
    setSelected(group.tests[0].id);
  };
  const toggleGroup = (id: string) => {
    if (isCollapsed(id)) {
      goToGroup(id);
      return;
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  };
  return (
    <>
      <aside className="secondary-menu tests-menu" aria-label={t('Tests menu')}>
        <div className="tests-menu-heading">
          <h2>{t('Tests')}</h2>
          <span
            title={
              missing ? t('Analyzed {0} of {1} test methods', total - missing, total) : undefined
            }
          >
            {missing ? `${total - missing} / ${total}` : tests.length}
          </span>
        </div>
        <div className="tests-filter">
          <input
            aria-label={t('Search tests')}
            placeholder={t('Find a test…')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setExpanded(new Set());
            }}
          />
          {snapshots.length > 1 && (
            <select
              aria-label={t('Test service')}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              <option value="all">{t('All services')}</option>
              {snapshots.map((snapshot) => (
                <option key={snapshot.repoId} value={snapshot.repoId}>
                  {snapshot.repoName}
                </option>
              ))}
            </select>
          )}
        </div>
        {revisionMarks && (
          <div className="menu-revision-summary">
            {t('Since the last review ·')}{' '}
            {tests.filter((test) => revisionMarks.has(test.id)).length} {t('tests')}
            {showingPrevious && (
              <button className="text-button" onClick={onLatest}>
                {t('Show the latest version →')}
              </button>
            )}
          </div>
        )}
        <nav className="test-list" aria-label={t('Tests by scenario')}>
          {groups.map((group) => (
            <section className="test-group" key={group.id}>
              <button
                className="test-group-toggle"
                aria-expanded={!isCollapsed(group.id)}
                aria-controls={`test-group-${group.id}`}
                title={group.title}
                onClick={() => toggleGroup(group.id)}
              >
                <span className="test-group-chevron" aria-hidden="true">
                  <Icon name={isCollapsed(group.id) ? 'chevronRight' : 'chevronDown'} size={13} />
                </span>
                <strong>{group.title}</strong>
                <small>{group.tests.length}</small>
                {group.tests.some((test) => revisionMarks?.has(test.id)) && (
                  <span
                    className="review-revision-dot"
                    title={t(
                      'Changed since the last review: {0}',
                      group.tests.filter((test) => revisionMarks?.has(test.id)).length,
                    )}
                    aria-label={t('Changed since the last review')}
                  />
                )}
              </button>
              {!isCollapsed(group.id) && (
                <div id={`test-group-${group.id}`} className="test-group-items">
                  {group.tests.map((test) => (
                    <button
                      key={test.id}
                      data-menu-item
                      className={current?.id === test.id ? 'active' : ''}
                      aria-current={current?.id === test.id ? 'true' : undefined}
                      title={`${test.summary}${revisionMarks?.has(test.id) ? t(' · Since the last review') : ''}`}
                      onClick={() => setSelected(test.id)}
                    >
                      <span>{test.title}</span>
                      {revisionMarks?.has(test.id) && (
                        <span
                          className={`review-revision-dot ${revisionMarks.get(test.id)}`}
                          title={t(
                            '{0} since the last review',
                            reviewMarkLabels[revisionMarks.get(test.id)!],
                          )}
                          aria-label={t(
                            '{0} since the last review',
                            reviewMarkLabels[revisionMarks.get(test.id)!],
                          )}
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
          {!groups.length && (
            <p className="tests-menu-empty">{search ? t('No tests found') : t('No tests')}</p>
          )}
        </nav>
      </aside>
      <div className="tests-toolbar">
        <div>
          <strong>{activeGroup?.title ?? t('Tests')}</strong>
        </div>
        {canAnalyze && !ready && (
          <button
            className="primary"
            disabled={running}
            onClick={() => {
              setError('');
              void onAnalyze().catch((error) => setError(error.message));
            }}
          >
            {running ? t('Codex is analyzing tests…') : t('Complete the test analysis')}
          </button>
        )}
        {activeGroup && (
          <button
            className="text-button tests-next-group"
            disabled={!nextGroup}
            onClick={() => nextGroup && goToGroup(nextGroup.id, true)}
          >
            {t('Next scenario →')}
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      {current ? (
        <section className="test-detail" key={current.id}>
          <div className="test-heading">
            <div>
              <h3>{current.title}</h3>
              <code>{current.method}</code>
            </div>
            <ViewSwitch
              view={view}
              onView={onView}
              label={t('Test view')}
              diagram={current.steps.length > 0}
            />
          </div>
          {view === 'code' ? (
            code(current)
          ) : view === 'diagram' && current.steps.length ? (
            <>
              <div className="test-legend">
                {Object.entries(kinds).map(([kind, label]) => (
                  <span key={kind} className={kind}>
                    {label}
                  </span>
                ))}
              </div>
              <TestSequence test={current} indexes={indexes} onSource={onSource} />
            </>
          ) : (
            <TestDescription test={current} onSource={onSource} />
          )}
        </section>
      ) : (
        <div className="tests-workspace-empty inline-empty">
          {groups.length
            ? t('Choose a scenario in the menu on the left.')
            : search
              ? t('No tests match the search.')
              : ready
                ? t('No tests with verifiable references were found in the provided context.')
                : canAnalyze
                  ? t(
                      'Press “Complete the test analysis”: Codex prepares short descriptions, calls, assertions and mock data. Tests are not run.',
                    )
                  : t('There is no test analysis for this saved version.')}
        </div>
      )}
    </>
  );
}

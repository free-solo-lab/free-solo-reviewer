import { useEffect, useMemo, useState } from 'react';
import { groupTests } from '../shared/test-groups';
import { SequenceCanvas } from './SequenceCanvas';
import { reviewTestMethods, missingTestMethods } from '../shared/test-coverage';
import type { Evidence, ReviewTest, Scenario, Snapshot, SourceIndex } from '../shared/model';

const kinds = { setup: 'Подготовка', mock: 'Мок', call: 'Вызов', assertion: 'Проверка' };
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
        aria-label={source ? `Открыть весь код класса ${name}` : undefined}
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
        <title>{source ? `${name} · открыть весь код класса` : name}</title>
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
          aria-label={`Шаги теста ${test.title}`}
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
                    ? ` · ${step.data.length} ${step.data.length === 1 ? 'модель / набор данных' : 'моделей / наборов данных'}`
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
                <title>Открыть код теста и оставить комментарий</title>
              </g>
            );
          })}
        </svg>
      </SequenceCanvas>
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
}: {
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const total = reviewTestMethods(snapshots, indexes).length;
  const missing = missingTestMethods(snapshots, indexes, tests).length;
  const key = snapshots.map((snapshot) => snapshot.id).join(',');
  useEffect(() => {
    setSelected('');
    setError('');
    setRepo('all');
    setSearch('');
    setCollapsed(new Set());
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
          tests: group.tests.filter((test) =>
            `${group.title} ${test.title} ${test.summary} ${test.method} ${test.evidence.map((ref) => ref.path).join(' ')}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          ),
        }))
        .filter((group) => group.tests.length),
    [tests, scenarios, indexes, repo, search],
  );
  const isCollapsed = (id: string) => collapsed.has(id);
  const visible = groups.filter((group) => !isCollapsed(group.id)).flatMap((group) => group.tests);
  const current = visible.find((test) => test.id === selected) ?? visible[0];
  const activeGroup = groups.find((group) => group.tests.some((test) => test.id === current?.id));
  const nextGroup = groups[groups.findIndex((group) => group.id === activeGroup?.id) + 1];
  const goToGroup = (id: string, closeCurrent = false) => {
    const group = groups.find((item) => item.id === id);
    if (!group) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (closeCurrent && activeGroup) next.add(activeGroup.id);
      next.delete(id);
      return next;
    });
    setSelected(group.tests[0].id);
  };
  const toggleGroup = (id: string) => {
    if (isCollapsed(id)) {
      goToGroup(id);
      return;
    }
    setCollapsed((previous) => new Set(previous).add(id));
    if (activeGroup?.id === id && nextGroup) goToGroup(nextGroup.id);
  };
  return (
    <>
      <aside className="secondary-menu tests-menu" aria-label="Меню тестов">
        <div className="tests-menu-heading">
          <h2>Тесты</h2>
          <span
            title={
              missing ? `Разобрано ${total - missing} из ${total} тестовых методов` : undefined
            }
          >
            {missing ? `${total - missing} / ${total}` : tests.length}
          </span>
        </div>
        <div className="tests-filter">
          <input
            aria-label="Поиск теста"
            placeholder="Найти тест…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setCollapsed(new Set());
            }}
          />
          {snapshots.length > 1 && (
            <select
              aria-label="Сервис теста"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              <option value="all">Все сервисы</option>
              {snapshots.map((snapshot) => (
                <option key={snapshot.repoId} value={snapshot.repoId}>
                  {snapshot.repoName}
                </option>
              ))}
            </select>
          )}
        </div>
        <nav className="test-list" aria-label="Тесты по сценариям">
          {groups.map((group) => (
            <section className="test-group" key={group.id}>
              <button
                className="test-group-toggle"
                aria-expanded={!isCollapsed(group.id)}
                aria-controls={`test-group-${group.id}`}
                onClick={() => toggleGroup(group.id)}
              >
                <span className="test-group-chevron" aria-hidden="true">
                  {isCollapsed(group.id) ? '▸' : '▾'}
                </span>
                <strong>{group.title}</strong>
                <small>{group.tests.length}</small>
              </button>
              {!isCollapsed(group.id) && (
                <div id={`test-group-${group.id}`} className="test-group-items">
                  {group.tests.map((test) => (
                    <button
                      key={test.id}
                      className={current?.id === test.id ? 'active' : ''}
                      aria-current={current?.id === test.id ? 'true' : undefined}
                      title={test.summary}
                      onClick={() => setSelected(test.id)}
                    >
                      {test.title}
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
          {!groups.length && (
            <p className="tests-menu-empty">{search ? 'Тесты не найдены' : 'Нет тестов'}</p>
          )}
        </nav>
      </aside>
      <div className="tests-toolbar">
        <div>
          <strong>{activeGroup?.title ?? 'Тесты'}</strong>
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
            {running ? 'Codex разбирает тесты…' : 'Дополнить разбор тестов'}
          </button>
        )}
        {activeGroup && (
          <button
            className="text-button tests-next-group"
            disabled={!nextGroup}
            onClick={() => nextGroup && goToGroup(nextGroup.id, true)}
          >
            Следующий сценарий →
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="panel analysis-error">
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
            {current.evidence[0] && (
              <button onClick={() => onSource(current.evidence[0])}>Код и комментарий →</button>
            )}
          </div>
          <p className="test-short-summary">{current.summary}</p>
          <div className="test-legend">
            {Object.entries(kinds).map(([kind, label]) => (
              <span key={kind} className={kind}>
                {label}
              </span>
            ))}
          </div>
          <TestSequence test={current} indexes={indexes} onSource={onSource} />
        </section>
      ) : (
        <div className="tests-workspace-empty inline-empty">
          {groups.length
            ? 'Выберите сценарий в меню слева.'
            : search
              ? 'Тесты не найдены по запросу.'
              : ready
                ? 'В переданном контексте не найдено тестов с проверяемыми ссылками.'
                : canAnalyze
                  ? 'Нажмите «Дополнить разбор тестов»: Codex подготовит краткие описания, вызовы, проверки и данные моков. Тесты не запускаются.'
                  : 'Разбор тестов для этой сохранённой версии отсутствует.'}
        </div>
      )}
    </>
  );
}

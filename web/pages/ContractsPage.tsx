import { useEffect, useState } from 'react';
import type { BuildModule, BuildTool, Contract, Evidence } from '../../shared/model';
import { Empty, SwaggerView } from '../components';
import { Icon } from '../icons';
import { cx } from '../ui/cx';
import { plural } from '../ui/plural';
import { Badge } from '../workspace/Badge';
import { useWorkspace } from '../workspace/state';
import styles from './ContractsPage.module.css';
import { SourcePanel } from '../workspace/SourcePanel';
import { contractSourceSummary } from '../../shared/contract-summary';
import { t, tc } from '../../shared/i18n';

const formats: Record<NonNullable<Contract['format']>, string> = {
  openapi: 'OpenAPI',
  'openapi-fragment': 'OpenAPI',
  thrift: 'Thrift',
  protobuf: 'Protobuf',
  graphql: 'GraphQL',
  antlr: 'ANTLR',
};
const statuses: Record<string, string> = {
  A: tc('migration', 'Added'),
  D: tc('migration', 'Removed'),
  R: t('Renamed'),
};
const tools: Record<BuildTool, string> = {
  gradle: 'Gradle',
  maven: 'Maven',
  npm: 'npm',
  go: 'Go',
  cargo: 'Cargo',
  bazel: 'Bazel',
  dotnet: '.NET',
  python: 'Python',
};

interface ModuleGroup {
  key: string;
  module: BuildModule | null;
  contracts: Contract[];
}
/** Contracts of each service grouped by the build module that owns them; loose files go last. */
function groupByModule(contracts: Contract[], repoIds: string[]) {
  return repoIds
    .map((repoId) => {
      const groups = new Map<string, ModuleGroup>();
      for (const contract of contracts.filter((c) => c.repoId === repoId)) {
        const module = contract.build?.module ?? null;
        const key = module ? `${repoId}:${module.dir}` : `${repoId}:`;
        if (!groups.has(key)) groups.set(key, { key, module, contracts: [] });
        groups.get(key)!.contracts.push(contract);
      }
      const modules = [...groups.values()].sort(
        (a, b) =>
          Number(!a.module) - Number(!b.module) ||
          (a.module?.name ?? '').localeCompare(b.module?.name ?? ''),
      );
      return { repoId, modules };
    })
    .filter((service) => service.modules.length);
}

/** Changed API contracts: their files on the left, the diff or the assembled Swagger UI. */
export function ContractsPage() {
  const {
    session,
    result,
    reviewVersion,
    service,
    setService,
    contractId,
    setContractId,
    contractView,
    setContractView,
    openSource,
    source,
    setSource,
    sourceKeyboard,
    busy,
  } = useWorkspace();
  const [search, setSearch] = useState('');
  const contracts = (
    reviewVersion ? (result?.contracts ?? []) : (session?.contracts ?? result?.contracts ?? [])
  ).filter((c) => service === 'all' || c.repoId === service);
  const visible = contracts.filter((c) =>
    `${c.title} ${c.path}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const contract = contracts.find((c) => c.id === contractId) ?? contracts[0];
  const fileOf = (c: Contract) =>
    session?.snapshots
      .find((snapshot) => snapshot.repoId === c.repoId)
      ?.files.find((file) => file.path === c.path);
  const file = contract && fileOf(contract);
  const swagger = !!contract && contract.format !== 'openapi-fragment' && !contract.source;
  const view = swagger ? contractView : 'changes';
  const repoName = (repoId: string) =>
    session?.snapshots.find((snapshot) => snapshot.repoId === repoId)?.repoName ?? repoId;
  const services = groupByModule(
    visible,
    session?.snapshots.map((snapshot) => snapshot.repoId) ?? [],
  );
  const snapshotsKey = session?.snapshots.map((s) => s.id).join(',');
  const selectedEvidence = contract?.evidence[0];
  useEffect(() => {
    if (!contract || view !== 'changes' || !selectedEvidence) return;
    setSource(null);
    void openSource(selectedEvidence);
  }, [session?.id, snapshotsKey, contract?.id, view, reviewVersion?.id]);
  if (!session) return null;
  const savedDescriptions = contract
    ? [
        ...new Set(
          (result?.changes ?? [])
            .filter(
              (c) =>
                c.evidence.repoId === contract.repoId &&
                (c.evidence.path === contract.path || c.evidence.path === file?.oldPath),
            )
            .map((c) => c.text.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const description = savedDescriptions.length
    ? savedDescriptions
    : contract?.source
      ? contractSourceSummary(contract.format, contract.source.before, contract.source.after)
      : (contract?.changes ?? []);
  return (
    <>
      <aside className="secondary-menu" aria-label={t('Contracts menu')}>
        <div className="tests-menu-heading">
          <h2>{t('Contracts')}</h2>
          <span>{visible.length}</span>
        </div>
        <div className="tests-filter">
          <input
            aria-label={t('Search contracts')}
            placeholder={t('Find a contract…')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {session.snapshots.length > 1 && (
            <select
              aria-label={t('Contract service')}
              value={service}
              onChange={(event) => setService(event.target.value)}
            >
              <option value="all">{t('All services')}</option>
              {session.snapshots.map((snapshot) => (
                <option key={snapshot.repoId} value={snapshot.repoId}>
                  {snapshot.repoName}
                </option>
              ))}
            </select>
          )}
        </div>
        <nav className="scenario-menu-list" aria-label={t('Changed contracts')}>
          {services.map(({ repoId, modules }) => (
            <div key={repoId} className={styles.service}>
              {services.length > 1 && <h3>{repoName(repoId)}</h3>}
              {modules.map(({ key, module, contracts: files }) => (
                <div key={key} className={styles.module}>
                  <div
                    className={styles.moduleName}
                    title={module ? module.dir || t('Repository root') : undefined}
                  >
                    <Icon name="box" size={13} />
                    <span>{module?.name ?? t('Outside build modules')}</span>
                    {module && <em>{tools[module.tool]}</em>}
                  </div>
                  {files.map((c) => {
                    const status = fileOf(c)?.status[0] ?? 'M';
                    const users = c.build?.consumers.length ?? 0;
                    return (
                      <button
                        key={c.id}
                        data-menu-item
                        className={cx(styles.entry, c.id === contract?.id && 'active')}
                        aria-current={c.id === contract?.id ? 'page' : undefined}
                        title={c.path}
                        onClick={() => setContractId(c.id)}
                      >
                        <span className={styles.entryName}>{c.path.split('/').pop()}</span>
                        <span className={styles.entryMeta}>
                          {formats[c.format ?? 'openapi']}
                          {statuses[status] && ` · ${statuses[status]}`}
                          {users > 0 &&
                            ` · ${users === 1 ? t('depends') : t('depend')} ${plural(users, 'module', 'modules')}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
          {!visible.length && (
            <p className="tests-menu-empty">
              {search ? t('No contracts found') : t('No changed contracts')}
            </p>
          )}
        </nav>
      </aside>
      {contract ? (
        <section className="overview-workspace" aria-label={contract.title}>
          <header className="overview-workspace-toolbar">
            <div className={styles.title}>
              <h2 title={contract.title}>{contract.title}</h2>
              <span className={styles.format}>{formats[contract.format ?? 'openapi']}</span>
              <Badge value={contract.reconstructed ? 'inferred' : 'extracted'} />
            </div>
            {swagger && (
              <div className="view-switch" role="tablist" aria-label={t('Contract view')}>
                {(
                  [
                    ['changes', t('Changes')],
                    ['swagger', 'Swagger UI'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={view === id}
                    className={view === id ? 'active' : undefined}
                    onClick={() => setContractView(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </header>
          {view === 'swagger' ? (
            <div className={cx('overview-workspace-content', styles.swagger)}>
              <SwaggerView key={contract.id} contract={contract} />
            </div>
          ) : (
            <>
              <details className={styles.description} key={contract.id} open>
                <summary>{t('Change summary')}</summary>
                <div className={styles.descriptionBody}>
                  <ul className={styles.changes}>
                    {description.map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                  </ul>
                  <div className={styles.file}>
                    <code title={contract.path}>{contract.path}</code>
                  </div>
                  {contract.error && <p className="error-text">{contract.error}</p>}
                  <BuildPanel contract={contract} repoName={repoName} onOpen={openSource} />
                </div>
              </details>
              <section
                className="inline-source-panel"
                aria-label={t('Contract code and comments')}
                onKeyDownCapture={sourceKeyboard}
              >
                {source ? (
                  <SourcePanel
                    inline
                    actions={
                      source.evidence.path !== selectedEvidence?.path ? (
                        <button
                          className="text-button"
                          onClick={() => {
                            if (selectedEvidence) void openSource(selectedEvidence);
                          }}
                        >
                          {t('To the contract')}
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  <p className="inline-empty">
                    {busy
                      ? t('Loading the contract code…')
                      : t('The contract code is unavailable.')}
                  </p>
                )}
              </section>
            </>
          )}
        </section>
      ) : (
        <div className={styles.empty}>
          <Empty title={t('No changed contracts')}>
            {t(
              'Shows changed OpenAPI, Thrift, Protobuf, GraphQL and ANTLR files, including specification fragments.',
            )}
          </Empty>
        </div>
      )}
    </>
  );
}

/** Where the contract is built and which modules build against it. */
function BuildPanel({
  contract,
  repoName,
  onOpen,
}: {
  contract: Contract;
  repoName: (repoId: string) => string;
  onOpen: (evidence: Evidence) => unknown;
}) {
  const build = contract.build;
  if (!build) return null;
  const label = (module: BuildModule) =>
    module.repoId === contract.repoId ? module.name : `${repoName(module.repoId)} · ${module.name}`;
  return (
    <section className={styles.build} aria-label={t('Contract build')}>
      <div className={styles.buildRow}>
        <span className={styles.buildLabel}>{t('Module')}</span>
        {build.module ? (
          <button className={styles.moduleLink} onClick={() => void onOpen(build.module!.evidence)}>
            <Icon name="box" size={13} />
            {build.module.name}
            <em>{tools[build.module.tool]}</em>
          </button>
        ) : (
          <span className={styles.none}>{t('The file belongs to no build module')}</span>
        )}
        {build.generators.length > 0 && (
          <span className={styles.generators}>
            {t('Generation:')} {build.generators.join(', ')}
          </span>
        )}
      </div>
      <div className={styles.buildRow}>
        <span className={styles.buildLabel}>{t('Built together with it')}</span>
        {build.consumers.length ? (
          <ul className={styles.consumers}>
            {build.consumers.map((consumer) => (
              <li key={`${consumer.repoId}:${consumer.dir}`}>
                <button
                  className={styles.moduleLink}
                  title={consumer.evidence.path}
                  onClick={() => void onOpen(consumer.evidence)}
                >
                  <Icon name="box" size={13} />
                  {label(consumer)}
                  <em>{tools[consumer.tool]}</em>
                </button>
                <span className={styles.via}>
                  {consumer.via === 'path'
                    ? t('reads the contract file')
                    : consumer.via === 'transitive'
                      ? t('via {0}', consumer.through)
                      : t('depends on the module')}
                  {consumer.generators.length > 0 && ` · ${consumer.generators.join(', ')}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className={styles.none}>
            {build.module
              ? t('No other module in this review depends on it')
              : t('No dependent modules found')}
          </span>
        )}
      </div>
    </section>
  );
}

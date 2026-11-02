import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command, git } from '../server/process.js';
import type { GitHubGateway, RemoteReview, ReviewPayload } from '../server/github.js';
import type { AnalysisProvider, AnalysisInput } from '../server/provider.js';
import type { PullRequest, Repository, ModelResult, ReviewDiscussion } from '../shared/model.js';

export class FakeGitHub implements GitHubGateway {
  comments: Omit<ReviewDiscussion, 'repoId'>[] = [];
  async discussion() {
    return this.comments;
  }
  login = 'reviewer';
  submissions: ReviewPayload[] = [];
  posted: RemoteReview[] = [];
  throwAfterSubmit = false;
  throwBeforeSubmit = false;
  changed = false;
  constructor(public pr: PullRequest) {}
  async listPRs() {
    return [this.pr];
  }
  async pull() {
    return this.changed ? { ...this.pr, headRefOid: 'e'.repeat(40) } : this.pr;
  }
  async user() {
    return { login: this.login };
  }
  async permission() {
    return true;
  }
  async reviews() {
    return this.posted;
  }
  async submit(_slug: string, _number: number, payload: ReviewPayload) {
    if (this.throwBeforeSubmit) throw new Error('timeout before response');
    this.submissions.push(payload);
    const row: RemoteReview = {
      id: this.submissions.length,
      html_url: `https://github.com/example/orders/pull/12#pullrequestreview-${this.submissions.length}`,
      body: payload.body,
      commit_id: payload.commit_id,
      state:
        payload.event === 'APPROVE'
          ? 'APPROVED'
          : payload.event === 'REQUEST_CHANGES'
            ? 'CHANGES_REQUESTED'
            : 'COMMENTED',
      user: { login: this.login },
    };
    this.posted.push(row);
    if (this.throwAfterSubmit) throw new Error('timeout after accepted');
    return row;
  }
}
export class FixtureProvider implements AnalysisProvider {
  id = 'fixture-demo';
  async analyze(
    input: AnalysisInput,
    signal: AbortSignal,
    progress: (s: string) => void,
  ): Promise<ModelResult> {
    signal.throwIfAborted();
    progress('Демонстрационные сценарии: проверяем связи заказа и оплаты.');
    const orders = input.snapshots[0],
      payments = input.snapshots[1];
    const method = input.indexes
      .find((i) => i.repoId === orders.repoId && i.side === 'head')
      ?.methods.find((m) => m.name === 'createOrder');
    const e = method?.evidence ?? {
      repoId: orders.repoId,
      side: 'head' as const,
      path: 'src/main/java/example/OrderService.java',
      startLine: 8,
      endLine: 12,
    };
    const from = orders.repoId,
      to = payments?.repoId ?? orders.repoId;
    return {
      summary:
        'Создание заказа теперь включает синхронный вызов оплаты внутри транзакции базы данных. При сетевой ошибке локальная запись может откатиться, но состояние удалённого платежа требует отдельной проверки.\n\nТакже изменены схема заказа и API-контракт. Это демонстрационные данные для проверки интерфейса.',
      findings: [
        {
          id: 'f1',
          title: 'Внешний платёж выполняется внутри транзакции',
          summary:
            'Вызов paymentClient.charge() выполняется после сохранения заказа, до завершения транзакции. При таймауте удалённая операция может завершиться, пока локальная транзакция откатится. В изменённом методе нет явной компенсации.',
          severity: 'high',
          confidence: 'inferred',
          evidence: [e],
        },
      ],
      scenarios: [
        {
          id: 'create-order',
          title: 'Создание заказа и оплата',
          summary: 'Путь вызова из OrderService в PaymentClient; фактические задержки неизвестны.',
          confidence: 'inferred',
          evidence: [e],
          services: payments ? [from, to] : [from],
          steps: [
            {
              id: 'step1',
              kind: 'call',
              from,
              to: from,
              label: 'Сохранить заказ',
              change: 'unchanged',
              branch: '',
              confidence: 'inferred',
              evidence: [e],
            },
            {
              id: 'step2',
              kind: 'call',
              from,
              to,
              label: 'POST /payments · charge',
              change: 'added',
              branch: 'После сохранения заказа',
              confidence: 'inferred',
              evidence: [e],
            },
            {
              id: 'step3',
              kind: 'return',
              from: to,
              to: from,
              label: 'Результат оплаты',
              change: 'added',
              branch: 'Если вызов завершился успешно',
              confidence: 'inferred',
              evidence: [e],
            },
          ],
        },
      ],
      database: [
        {
          id: 'orm-orders',
          title: 'Сохранение заказа через JPA',
          summary:
            'Вызов repository.save(order) перед обращением к оплате. Точный SQL зависит от маппинга сущности и flush.',
          confidence: 'inferred',
          evidence: [e],
          kind: 'orm',
          dialect: 'Не определён',
          sql: '',
          tables: ['orders'],
          unknowns: ['Момент flush не подтверждён', 'Нативный SQL не восстановлен'],
        },
      ],
      transactions: [
        {
          id: 'tx1',
          title: 'OrderService.createOrder()',
          summary: 'Локальная транзакция содержит запись в базу и удалённый вызов оплаты.',
          confidence: 'inferred',
          evidence: [e],
          propagation: 'REQUIRED (по умолчанию Spring)',
          rollback:
            'Необработанное RuntimeException обычно приводит к rollback. Поведение для checked exceptions и удалённого платежа требует проверки.',
          operations: [
            {
              label: 'repository.save(order)',
              kind: 'database',
              risk: 'Flush и длительность блокировок неизвестны',
              evidence: [e],
            },
            {
              label: 'paymentClient.charge(order.id)',
              kind: 'remote',
              risk: 'Неизвестное время ожидания сети внутри транзакции',
              evidence: [e],
            },
          ],
          unknowns: [
            'Применяется ли Spring proxy к точке входа',
            'Компенсация удалённой операции не найдена',
          ],
        },
      ],
      gaps: [
        'Демонстрационный анализ: модель не вызывалась.',
        'Трассировки отсутствуют; порядок и длительность не подтверждены в runtime.',
      ],
    };
  }
}
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-test-'));
  const path = join(root, 'orders');
  const bare = join(root, 'orders.git');
  await mkdir(path);
  await command('git', ['init', '--bare', bare]);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.email', 'test@example.com']);
  await git(path, ['config', 'user.name', 'Review test']);
  async function put(name: string, text: string) {
    const dest = join(path, name);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, text);
  }
  const base = `package example;
import org.springframework.transaction.annotation.Transactional;
class OrderService {
  private OrderRepository repository;
  private PaymentClient paymentClient;
  @Transactional
  public Order createOrder(Order order) {
    repository.save(order);
    return order;
  }
  public void nested() { this.createOrder(new Order()); }
}
`;
  await put('src/main/java/example/OrderService.java', base);
  await put(
    'src/main/kotlin/example/PaymentClient.kt',
    `package example
import org.springframework.web.bind.annotation.PostMapping
interface PaymentClient {
  @PostMapping("/payments")
  fun charge(orderId: String): Payment
}
`,
  );
  await put(
    'openapi.yaml',
    'openapi: 3.0.3\ninfo:\n  title: Orders API\n  version: 1.0.0\npaths:\n  /orders:\n    get:\n      responses:\n        "200":\n          description: OK\n',
  );
  await put('src/main/java/example/Legacy.java', 'class Legacy { void oldMethod() {} }\n');
  await put('.env', 'GH_TOKEN=should-never-be-materialized');
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'base']);
  const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  await put(
    'src/main/java/example/OrderService.java',
    base.replace('    return order;', '    paymentClient.charge(order.id);\n    return order;'),
  );
  await put(
    'openapi.yaml',
    'openapi: 3.0.3\ninfo:\n  title: Orders API\n  version: 2.0.0\npaths:\n  /orders:\n    post:\n      responses:\n        "201":\n          description: Created\n',
  );
  await put(
    'src/main/resources/db/migration/V2__order_status.sql',
    "ALTER TABLE orders ADD COLUMN payment_status varchar(32);\nUPDATE orders SET payment_status = 'pending';\n",
  );
  await git(path, [
    'mv',
    'src/main/java/example/Legacy.java',
    'src/main/java/example/Renamed.java',
  ]);
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'Add payment step']);
  const headSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  await git(path, ['remote', 'add', 'origin', bare]);
  await git(path, ['push', 'origin', `${baseSha}:refs/heads/main`, `${headSha}:refs/pull/12/head`]);
  const pr: PullRequest = {
    number: 12,
    title: 'Оплата при создании заказа',
    url: 'https://github.com/example/orders/pull/12',
    headRefOid: headSha,
    baseRefOid: baseSha,
    baseRefName: 'main',
    headRefName: 'feature/payment',
    body: 'Payment integration',
    author: { login: 'author' },
  };
  const repo: Repository = {
    id: randomUUID(),
    path,
    name: 'order-service',
    slug: 'example/orders',
  };
  return {
    root,
    repo,
    pr,
    github: new FakeGitHub(pr),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

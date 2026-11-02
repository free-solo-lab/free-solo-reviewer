import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, FixtureProvider } from './fixtures.js';
import { createApp } from '../server/app.js';
import { createSnapshot } from '../server/repository.js';
import type { ReviewSession } from '../shared/model.js';
const orders = await fixture(),
  payments = await fixture();
payments.repo.name = 'payment-service';
payments.repo.slug = 'example/payments';
const port = Number(process.env.REVIEW_PORT ?? 4318);
const { app, store, analysis } = createApp({
  dataDir: join(orders.root, 'demo-app'),
  github: orders.github,
  provider: new FixtureProvider(),
  port,
  demo: true,
});
store.saveRepository(orders.repo);
store.saveRepository(payments.repo);
const orderSnapshot = await createSnapshot(
  orders.repo,
  12,
  join(orders.root, 'snapshots'),
  orders.github,
);
const paymentSnapshot = await createSnapshot(
  payments.repo,
  null,
  join(orders.root, 'snapshots'),
  payments.github,
);
const session: ReviewSession = {
  id: randomUUID(),
  title: 'Создание заказа и оплата',
  createdAt: new Date().toISOString(),
  snapshots: [orderSnapshot, paymentSnapshot],
  run: null,
};
store.saveSession(session);
analysis.start(session);
await app.listen({ host: '127.0.0.1', port });
console.log(
  `Demo: http://127.0.0.1:${port} (GitHub and Codex are simulated; no real reviews can be sent)`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app
      .close()
      .then(() => Promise.all([orders.cleanup(), payments.cleanup()]))
      .then(() => process.exit(0));
  });

import { createApp } from './app.js';
const port = Number(process.env.REVIEW_PORT ?? 4318);
const { app } = createApp({ port });
await app.listen({ port, host: '127.0.0.1' });
console.log(`Review: http://127.0.0.1:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });

import { startReviewerService } from './service.js';
import { t } from '../shared/i18n.js';
try {
  const service = await startReviewerService();
  console.log(`Review: ${service.url}${service.reused ? t(' (server already running)') : ''}`);
  if (!service.reused)
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void service.close().then(
          () => process.exit(0),
          (error) => {
            console.error(error);
            process.exit(1);
          },
        );
      });
} catch (error) {
  console.error(`Reviewer: ${(error as Error).message}`);
  process.exitCode = 1;
}

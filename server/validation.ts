import type { ModelResult, Snapshot, Evidence } from '../shared/model.js';
import { emptyModelResult, modelResultSchema } from '../shared/model.js';
import { isTestPath } from '../shared/test-coverage.js';
import { readSource } from './repository.js';

export async function validateModelResult(
  raw: unknown,
  snapshots: Snapshot[],
): Promise<ModelResult> {
  const result = decodeModelResult(raw);
  const cache = new Map<string, number>();
  const valid = async (e: Evidence) => {
    const s = snapshots.find((s) => s.repoId === e.repoId);
    if (!s || e.endLine < e.startLine) return false;
    const key = `${e.repoId}:${e.side}:${e.path}`;
    try {
      if (!cache.has(key)) cache.set(key, (await readSource(s, e)).split('\n').length);
      return e.endLine <= cache.get(key)!;
    } catch {
      return false;
    }
  };
  const check = async <T extends { evidence: Evidence[] }>(item: T): Promise<T> => {
    const refs: Evidence[] = [];
    for (const e of item.evidence) if (await valid(e)) refs.push(e);
    if (refs.length !== item.evidence.length)
      result.gaps.push('Отброшены ссылки модели на отсутствующие файлы или строки.');
    return {
      ...item,
      evidence: refs,
      ...('confidence' in item
        ? { confidence: !refs.length || item.confidence === 'unknown' ? 'unknown' : 'inferred' }
        : {}),
    };
  };
  for (const key of ['findings', 'scenarios', 'database', 'transactions'] as const) {
    const checked = await Promise.all(result[key].map(check));
    // A claim without evidence is never displayed as an actionable finding.
    const kept = checked.filter((v) => v.evidence.length > 0);
    if (kept.length !== checked.length)
      result.gaps.push(`Раздел ${key}: отброшены утверждения без проверяемых ссылок.`);
    (result[key] as unknown[]) = kept;
  }
  const repoIds = new Set(snapshots.map((s) => s.repoId));
  if (result.tests) {
    const isTest = (ref: Evidence) => isTestPath(ref.path);
    const tests = [];
    for (const test of result.tests) {
      const checked = await check(test);
      if (!checked.evidence.some(isTest)) continue;
      checked.evidence.sort((a, b) => Number(isTest(b)) - Number(isTest(a)));
      checked.steps = [];
      for (const step of test.steps) {
        const checkedStep = await check(step);
        checkedStep.evidence.sort((a, b) => Number(isTest(b)) - Number(isTest(a)));
        if (!checkedStep.evidence.some(isTest)) {
          result.gaps.push(`Тест «${test.title}»: пропущен шаг без ссылки на тест или его setup.`);
          continue;
        }
        checkedStep.data = [];
        for (const data of step.data) {
          const checkedData = await check(data);
          if (checkedData.evidence.length) checkedStep.data.push(checkedData);
        }
        checked.steps.push(checkedStep);
      }
      tests.push(checked);
    }
    result.tests = tests;
  }
  for (const operation of result.database) {
    if (operation.query) {
      const ref = operation.query.evidence;
      if (!(await valid(ref))) {
        result.gaps.push(`SQL «${operation.title}»: недостоверная ссылка на метод запроса.`);
        operation.query = null;
        operation.sql = '';
      } else if (!operation.evidence.some((e) => JSON.stringify(e) === JSON.stringify(ref)))
        operation.evidence.push(ref);
    }
  }
  for (const scenario of result.scenarios) {
    scenario.services = scenario.services.filter((s) => repoIds.has(s));
    const steps = [];
    for (const step of scenario.steps) {
      const checked = await check(step);
      if (checked.evidence.length && repoIds.has(step.from) && repoIds.has(step.to))
        steps.push(checked);
      else result.gaps.push(`В сценарии «${scenario.title}» пропущен неподтверждённый шаг.`);
    }
    scenario.steps = steps;
  }
  for (const tx of result.transactions) {
    const operations = [];
    for (const op of tx.operations) {
      const checked = await check(op);
      if (checked.evidence.length) operations.push(checked);
    }
    tx.operations = operations;
  }
  if (result.followUp) {
    result.followUp.items = await Promise.all(
      result.followUp.items.map(async (item) => {
        const checked = await check(item);
        return {
          ...checked,
          status:
            ['fixed', 'still_present', 'changed'].includes(checked.status) &&
            !checked.evidence.length
              ? ('unknown' as const)
              : checked.status,
        };
      }),
    );
  }
  result.gaps = [...new Set(result.gaps)];
  return result;
}

/** A malformed section cannot erase valid output from the other sections. */
export function decodeModelResult(raw: unknown): ModelResult {
  // Current Codex responses omit the retired report; legacy saved reports still decode.
  if (raw && typeof raw === 'object' && !('transactions' in raw))
    raw = { ...raw, transactions: [] };
  if (raw && typeof raw === 'object' && 'followUp' in raw && raw.followUp === null) {
    const { followUp: _unused, ...initialReview } = raw;
    raw = initialReview;
  }
  const full = modelResultSchema.safeParse(raw);
  if (full.success) return full.data;
  if (!raw || typeof raw !== 'object') throw new Error('Модель не вернула объект анализа.');
  const object = raw as Record<string, unknown>,
    result = emptyModelResult();
  result.summary = typeof object.summary === 'string' ? object.summary : '';
  result.gaps = Array.isArray(object.gaps)
    ? object.gaps.filter((v): v is string => typeof v === 'string')
    : [];
  const followUp = modelResultSchema.shape.followUp.safeParse(object.followUp);
  if (followUp.success && followUp.data) result.followUp = followUp.data;
  if (Array.isArray(object.tests)) {
    result.tests = [];
    for (const item of object.tests) {
      const parsed = modelResultSchema.shape.tests.unwrap().element.safeParse(item);
      if (parsed.success) result.tests.push(parsed.data);
      else result.gaps.push('Раздел tests: пропущен элемент с некорректной структурой.');
    }
  }
  for (const key of ['findings', 'scenarios', 'database', 'transactions'] as const) {
    const items = object[key];
    if (!Array.isArray(items)) {
      result.gaps.push(`Раздел ${key}: модель вернула некорректный формат.`);
      continue;
    }
    for (const item of items) {
      const parsed = modelResultSchema.shape[key].element.safeParse(item);
      if (parsed.success) (result[key] as unknown[]).push(parsed.data);
      else result.gaps.push(`Раздел ${key}: пропущен элемент с некорректной структурой.`);
    }
  }
  return result;
}

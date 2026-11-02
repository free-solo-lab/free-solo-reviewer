import { describe, it, expect } from 'vitest';
import { indexSource } from '../server/indexer';
import {
  evidenceMethodLink,
  methodDefinitions,
  methodLinks,
  needsDefinitionPicker,
} from '../shared/code-navigation';
const service = `class RegistryService(val orderRegistrationService: OrderRegistrationService) {
 fun run(registration: String): String {
  return orderRegistrationService.registerOrder(registration)
 }
 fun local() { run("sample") }
}`;
const target = `class OrderRegistrationService {
 fun registerOrder(value: String): String { return value }
}`;
async function fixture() {
  const source = await indexSource(service, 'repo', 'head', 'RegistryService.kt');
  const definition = await indexSource(target, 'repo', 'head', 'OrderRegistrationService.kt');
  return { source, definition, origin: source.methods.find((m) => m.name === 'run')!.evidence };
}
describe('source definition navigation', () => {
  it('resolves the requested receiver.method to the pinned definition', async () => {
    const f = await fixture();
    const links = methodLinks(service, f.origin, [f.source, f.definition]);
    const link = links[2].find((l) => l.name === 'registerOrder')!;
    expect(service.split('\n')[2].slice(link.start, link.end)).toBe('registerOrder');
    expect(link.targets[0].evidence.path).toBe('OrderRegistrationService.kt');
    expect(needsDefinitionPicker(link)).toBe(false);
  });
  it('resolves unqualified calls in the same file and does not link declarations', async () => {
    const f = await fixture();
    const links = methodLinks(service, f.origin, [f.source, f.definition]);
    expect(links[1]).toHaveLength(0);
    expect(links[4].find((l) => l.name === 'run')?.targets[0].evidence.path).toBe(
      'RegistryService.kt',
    );
  });
  it('does not cross repositories or head/base versions', async () => {
    const f = await fixture();
    const other = await indexSource(target, 'another', 'head', 'OrderRegistrationService.kt');
    const base = await indexSource(target, 'repo', 'base', 'OrderRegistrationService.kt');
    expect(methodLinks(service, f.origin, [f.source, other, base])[2]).toHaveLength(0);
  });
  it('keeps overloads ambiguous instead of choosing one by filename', async () => {
    const f = await fixture();
    const overload = await indexSource(
      target.replace('\n}', '\n fun registerOrder(value: Int): String { return "x" }\n}'),
      'repo',
      'head',
      'OrderRegistrationService.kt',
    );
    const link = methodLinks(service, f.origin, [f.source, overload])[2][0];
    expect(link.targets).toHaveLength(2);
    expect(needsDefinitionPicker(link)).toBe(true);
  });
  it('requires selection when an arbitrary receiver has no established class mapping', async () => {
    const text = service
      .replaceAll('orderRegistrationService', 'worker')
      .replace(': OrderRegistrationService', ': ExternalWorker');
    const source = await indexSource(text, 'repo', 'head', 'RegistryService.kt');
    const f = await fixture();
    const link = methodLinks(text, f.origin, [source, f.definition])[2][0];
    expect(needsDefinitionPicker(link)).toBe(true);
    expect(link.targets[0].signature).not.toContain('Проверьте');
  });
  it.each(['java', 'kt'])(
    'offers the interface and transitive implementations for %s',
    async (ext) => {
      const texts =
        ext === 'java'
          ? [
              'package api; public interface Worker {\n String run(String value);\n }',
              'package api; public interface Specialized extends Worker {}',
              'package impl; import api.Specialized; class First implements Specialized { public String run(String value) { return value; } }',
              'package impl; import api.Worker; class Second implements Worker { public String run(String value) { return value; } }',
              'package impl; class Unrelated { public String run(String value) { return value; } }',
              'package app; import api.Worker; class Caller { private Worker delegate; String invoke() { return delegate.run("x"); } }',
            ]
          : [
              'package api\ninterface Worker { fun run(value: String): String }',
              'package api\ninterface Specialized : Worker {}',
              'package impl\nimport api.Specialized\nclass First : Specialized { override fun run(value: String): String { return value } }',
              'package impl\nimport api.Worker\nclass Second : Worker { override fun run(value: String): String { return value } }',
              'package impl\nclass Unrelated { fun run(value: String): String { return value } }',
              'package app\nimport api.Worker\nclass Caller(val delegate: Worker) { fun invoke(): String { return delegate.run("x") } }',
            ];
      const indexes = await Promise.all(
        texts.map((text, i) =>
          indexSource(
            text,
            'repo',
            'head',
            `${['Worker', 'Specialized', 'First', 'Second', 'Unrelated', 'Caller'][i]}.${ext}`,
          ),
        ),
      );
      const base = await indexSource(texts[3], 'repo', 'base', `Second.${ext}`);
      const other = await indexSource(texts[3], 'other', 'head', `Second.${ext}`);
      const method = indexes[0].methods[0];
      const targets = methodDefinitions(method, [...indexes, base, other]);
      expect(targets.map((m) => m.owner).sort()).toEqual([
        'api.Worker',
        'impl.First',
        'impl.Second',
      ]);
      expect(evidenceMethodLink(method.evidence, indexes)?.targets).toEqual(targets);
      const origin = indexes[5].methods[0].evidence;
      const link = methodLinks(texts[5], origin, indexes)
        .flat()
        .find((l) => l.name === 'run')!;
      expect(link.targets.map((m) => m.owner).sort()).toEqual([
        'api.Worker',
        'impl.First',
        'impl.Second',
      ]);
      expect(needsDefinitionPicker(link)).toBe(true);
      // A source-file/class link must still open the class directly.
      expect(
        evidenceMethodLink({ ...method.evidence, startLine: 1, endLine: 1 }, indexes),
      ).toBeNull();
    },
  );
  it('leaves external-library methods without a project definition as plain text', async () => {
    const f = await fixture();
    const text = 'class RegistryService { fun run() { println("test") } }';
    const source = await indexSource(text, 'repo', 'head', 'RegistryService.kt');
    expect(methodLinks(text, f.origin, [source, f.definition]).flat()).toHaveLength(0);
  });
});

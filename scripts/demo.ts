import { mkdir, writeFile } from 'node:fs/promises';
import scenarios from '../fixtures/scenarios.json';
import { runScenario, projection, type Scenario } from '../tests/scenario-harness';
const path = `artifacts/demo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(path, { recursive: true });
const results = scenarios.scenarios.map((raw) => {
  const scenario = raw as unknown as Scenario;
  const { ledger, initial, policy } = runScenario(scenario);
  return {
    id: scenario.id,
    title: scenario.title,
    synthetic: true,
    projection: projection(ledger, initial, policy),
    audit: ledger.audit,
  };
});
await writeFile(`${path}/scenario-projections.json`, JSON.stringify(results, null, 2));
console.log(
  `Saved ${results.length} synthetic scenario projections to ${path}. Assertions run separately with npm run test:acceptance.`,
);

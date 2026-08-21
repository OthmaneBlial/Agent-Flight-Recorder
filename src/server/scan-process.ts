import type { EvidencePolicyOverrides } from './policy.js';
import { loadEvidencePolicy } from './policy.js';
import { scanSources } from './scanner.js';
import { RecorderStore } from './store.js';

interface ScanProcessInput {
  databasePath: string;
  policy: EvidencePolicyOverrides;
}

process.once('disconnect', () => process.exit(0));

process.once('message', async (message: unknown) => {
  const input = message as ScanProcessInput;
  const store = new RecorderStore(input.databasePath, loadEvidencePolicy(input.policy));
  try {
    const result = await scanSources(store);
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
    process.disconnect();
  }
});

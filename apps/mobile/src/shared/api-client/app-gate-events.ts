export type ApiAppGate = 'update' | 'maintenance';

type ApiAppGateListener = (gate: ApiAppGate) => void;

const listeners = new Set<ApiAppGateListener>();

export function subscribeApiAppGates(listener: ApiAppGateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishApiAppGate(gate: ApiAppGate): void {
  for (const listener of [...listeners]) {
    try {
      listener(gate);
    } catch {
      // A view subscriber must not change the API response outcome.
    }
  }
}

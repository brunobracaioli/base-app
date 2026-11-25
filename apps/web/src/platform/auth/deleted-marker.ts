import { Redis } from '@upstash/redis';

const DELETED_MARKER_PREFIX = 'auth:deleted:v1:';
const REDIS_REQUEST_TIMEOUT_MS = 3_000;

export interface DeletedAccountMarkerClient {
  exists(key: string): Promise<number>;
}

export function createDeletedAccountMarkerReader(client: DeletedAccountMarkerClient) {
  return Object.freeze({
    async isDeleted(userId: string): Promise<boolean> {
      const markerCount = await client.exists(`${DELETED_MARKER_PREFIX}${userId}`);
      if (markerCount === 0) return false;
      if (markerCount === 1) return true;
      throw new Error('Deleted account marker response is invalid.');
    },
  });
}

export function createUpstashDeletedAccountMarkerReader(input: {
  readonly url: string;
  readonly token: string;
}) {
  const redis = new Redis({
    url: input.url,
    token: input.token,
    retry: false,
    signal: () => AbortSignal.timeout(REDIS_REQUEST_TIMEOUT_MS),
  });
  return createDeletedAccountMarkerReader(redis);
}

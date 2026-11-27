import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';

const FALLBACK_APP_VERSION = '0.0.0';

/** True when the bundle runs inside the Expo Go client from the app stores. */
export function isExpoGo(): boolean {
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/**
 * Version sent to the API and evaluated by the update gate. Inside Expo Go the native
 * version belongs to Expo Go itself, so the version declared in the app config is used.
 */
export function resolveAppVersion(): string {
  if (isExpoGo()) {
    return Constants.expoConfig?.version ?? FALLBACK_APP_VERSION;
  }
  return Application.nativeApplicationVersion ?? FALLBACK_APP_VERSION;
}

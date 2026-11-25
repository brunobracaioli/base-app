import { usePreventScreenCapture } from 'expo-screen-capture';

export function ScreenCaptureGuard() {
  usePreventScreenCapture();
  return null;
}

import { Platform, NativeModules } from 'react-native';
import type { CameraSource } from './types';

export function getAvailableSources(): CameraSource[] {
  const hasUvcNativeModule = Platform.OS === 'android' && !!NativeModules.UvcCamera;
  const sources: CameraSource[] = [
    {
      id: 'phone',
      type: 'phone',
      label: 'Built-in cam',
      supported: true,
      capabilities: {
        supportsPreview: true,
        supportsRecord: true,
        supportsAudio: true,
        resolutions: [
          { width: 1280, height: 720, label: '720p' },
          { width: 1920, height: 1080, label: '1080p' },
        ],
        frameRates: [24, 30, 60],
      },
    },
  ];

  sources.push({
    id: 'external-usb',
    type: 'external',
    label: 'External cam',
    description:
      Platform.OS === 'android'
        ? 'UVC over USB/OTG (coming soon)'
        : 'Work-in-progress UI on iOS; hardware support requires a vendor SDK.',
    supported: Platform.OS === 'ios' ? true : hasUvcNativeModule,
    unsupportedReason:
      Platform.OS === 'android'
        ? 'External USB cameras will be enabled once the UVC module is integrated.'
        : 'iOS does not expose generic UVC devices. This screen is for visual preview only.',
    capabilities: {
      supportsPreview: true,
      supportsRecord: Platform.OS === 'android',
      supportsAudio: false,
    },
  });

  return sources;
}

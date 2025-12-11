import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { UvcCameraModule, UvcCameraEvents, UvcDeviceInfo } from '@/native/UvcCameraModule';
import type { CameraSource } from './types';

type ExternalState = {
  devices: UvcDeviceInfo[];
  hasPermission: boolean;
  handle?: string;
};

export function useAndroidUvcSource(): {
  source: CameraSource | null;
  devices: UvcDeviceInfo[];
  selectDevice: (id: string) => Promise<void>;
  open: (deviceId: string) => Promise<string | null>;
  startPreview: (handle: string) => Promise<void>;
  startRecording: (handle: string, filePath: string, opts?: { resolution?: string; fps?: number }) => Promise<void>;
  stopRecording: (handle: string) => Promise<void>;
  close: (handle: string) => Promise<void>;
} {
  const [state, setState] = useState<ExternalState>({ devices: [], hasPermission: false });

  useEffect(() => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;

    const load = async () => {
      try {
        const devices = await UvcCameraModule.listDevices();
        setState((prev) => ({ ...prev, devices }));
      } catch (e) {
        setState((prev) => ({ ...prev, devices: [] }));
      }
    };

    load();

    const subs: any[] = [];
    if (UvcCameraEvents) {
      subs.push(
        UvcCameraEvents.addListener('deviceAttached', load),
        UvcCameraEvents.addListener('deviceDetached', load),
        UvcCameraEvents.addListener('permissionDenied', load),
      );
    }
    return () => subs.forEach((s) => s?.remove?.());
  }, []);

  const selectDevice = async (id: string) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;
    const granted = await UvcCameraModule.requestPermission(id);
    setState((prev) => ({ ...prev, hasPermission: granted }));
  };

  const open = async (deviceId: string) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return null;
    const handle = await UvcCameraModule.open(deviceId, {});
    setState((prev) => ({ ...prev, handle }));
    return handle;
  };

  const startPreview = async (handle: string) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;
    await UvcCameraModule.startPreview(handle);
  };

  const startRecording = async (handle: string, filePath: string, opts?: { resolution?: string; fps?: number }) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;
    await UvcCameraModule.startRecording(handle, {
      filePath,
      resolution: opts?.resolution,
      fps: opts?.fps ?? 30,
    });
  };

  const stopRecording = async (handle: string) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;
    await UvcCameraModule.stopRecording(handle);
  };

  const close = async (handle: string) => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return;
    await UvcCameraModule.close(handle);
    setState((prev) => ({ ...prev, handle: undefined }));
  };

  const source: CameraSource | null = useMemo(() => {
    if (Platform.OS !== 'android' || !UvcCameraModule) return null;
    return {
      id: 'external-usb',
      type: 'external',
      label: 'External cam',
      description: 'UVC over USB/OTG',
      supported: true,
      capabilities: {
        supportsPreview: true,
        supportsRecord: true,
        supportsAudio: false,
        resolutions: [
          { width: 1280, height: 720, label: '720p' },
          { width: 1920, height: 1080, label: '1080p' },
        ],
        frameRates: [24, 30],
      },
    };
  }, []);

  return {
    source,
    devices: state.devices,
    selectDevice,
    open,
    startPreview,
    startRecording,
    stopRecording,
    close,
  };
}


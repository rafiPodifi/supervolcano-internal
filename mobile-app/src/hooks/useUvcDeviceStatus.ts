import { useEffect, useState } from 'react';
import { UvcCameraModule, UvcCameraEvents } from '@/native/UvcCameraModule';

type UvcStatus = {
  available: boolean;
  connected: boolean;
  devices: { id: string; productName?: string; serialNumber?: string; hasPermission?: boolean }[];
  error?: string;
};

export function useUvcDeviceStatus(): UvcStatus {
  const [status, setStatus] = useState<UvcStatus>({
    available: !!UvcCameraModule,
    connected: false,
    devices: [],
  });

  useEffect(() => {
    let mounted = true;

    const loadDevices = async () => {
      if (!UvcCameraModule) {
        setStatus((prev) => ({ ...prev, available: false, connected: false, devices: [] }));
        return;
      }
      try {
        const devices = await UvcCameraModule.listDevices();
        if (!mounted) return;
        setStatus({
          available: true,
          connected: devices.length > 0,
          devices,
        });
      } catch (error: any) {
        if (!mounted) return;
        setStatus({
          available: true,
          connected: false,
          devices: [],
          error: error?.message || 'Unable to query UVC devices',
        });
      }
    };

    loadDevices();

    const subs: any[] = [];
    if (UvcCameraEvents) {
      subs.push(
        UvcCameraEvents.addListener('deviceAttached', loadDevices),
        UvcCameraEvents.addListener('deviceDetached', loadDevices),
      );
    }

    return () => {
      mounted = false;
      subs.forEach((s) => s?.remove?.());
    };
  }, []);

  return status;
}

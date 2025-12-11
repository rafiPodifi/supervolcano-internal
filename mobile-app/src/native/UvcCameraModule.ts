import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type UvcDeviceInfo = {
  id: string;
  vendorId?: number;
  productId?: number;
  productName?: string;
  serialNumber?: string;
  hasPermission?: boolean;
};

export type UvcCameraModuleType = {
  listDevices(): Promise<UvcDeviceInfo[]>;
  requestPermission(deviceId: string): Promise<boolean>;
  open(deviceId: string, opts: { resolution?: string; fps?: number; format?: string }): Promise<string>;
  startPreview(handle: string): Promise<void>;
  startRecording(handle: string, opts: { filePath: string; codec?: string; container?: string }): Promise<void>;
  stopRecording(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const nativeModule = NativeModules.UvcCamera as UvcCameraModuleType | undefined;

export const UvcCameraModule = Platform.OS === 'android' && nativeModule ? nativeModule : undefined;
export const UvcCameraEvents =
  Platform.OS === 'android' && nativeModule ? new NativeEventEmitter(NativeModules.UvcCamera) : undefined;
export type { UvcDeviceInfo, UvcCameraModuleType };

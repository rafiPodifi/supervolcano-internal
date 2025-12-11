// Camera source abstractions for phone and external devices

export type CameraSourceType = 'phone' | 'external';

export interface CameraResolution {
  width: number;
  height: number;
  label?: string;
}

export interface CameraCapabilities {
  supportsPreview: boolean;
  supportsRecord: boolean;
  supportsAudio: boolean;
  resolutions?: CameraResolution[];
  frameRates?: number[];
}

export interface CameraSource {
  id: string;
  type: CameraSourceType;
  label: string;
  description?: string;
  supported: boolean;
  unsupportedReason?: string;
  capabilities: CameraCapabilities;
}


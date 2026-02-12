/**
 * CAMERA SCREEN - Cross-Platform with Offline Support
 * Continuous recording with background segment uploads
 * Videos persist locally until confirmed uploaded
 * Uses react-native-vision-camera for physical lens selection
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
  ActivityIndicator,
  Animated,
  Platform,
  AppState,
  AppStateStatus,
  Linking,
  LayoutChangeEvent,
  Modal,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
  VideoFile,
} from 'react-native-vision-camera';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { UploadQueueService } from '@/services/upload-queue.service';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import { Toast } from '@/components/Toast';
import { useToast } from '@/hooks/useToast';
import * as Haptics from 'expo-haptics';
import { getAvailableSources } from '@/camera/sourceRegistry';
import type { CameraSource } from '@/camera/types';
import { useUvcDeviceStatus } from '@/hooks/useUvcDeviceStatus';
import * as FileSystem from 'expo-file-system/legacy';
import { UvcCameraModule, UvcCameraEvents } from '@/native/UvcCameraModule';
import { requireNativeComponent } from 'react-native';
import type { UserProfile } from '@/types/user.types';

const SEGMENT_DURATION = 300; // 5 minutes in seconds
const isAndroid = Platform.OS === 'android';

type LensType = 'ultra-wide' | 'wide' | 'telephoto';

const NativeUvcView = isAndroid ? requireNativeComponent('RNUvcCameraView') : null;
const FIXED_PREVIEW_WIDTH = 1280;
const FIXED_PREVIEW_HEIGHT = 720;
const FIXED_PREVIEW_ASPECT = FIXED_PREVIEW_WIDTH / FIXED_PREVIEW_HEIGHT;

type CameraScreenContentProps = {
  navigation: any;
  locationId: string;
  address?: string;
  insets: EdgeInsets;
  user: UserProfile;
};

function CameraScreenContent({
  navigation,
  locationId,
  address,
  insets,
  user,
}: CameraScreenContentProps) {
  const cameraRef = useRef<Camera>(null);

  // Lens selection state - default to ultra-wide
  const [selectedLens, setSelectedLens] = useState<LensType>('wide');

  // Get a device that supports all physical lenses for smooth switching
  const device = useCameraDevice('back', {
    physicalDevices: [
      'ultra-wide-angle-camera',
      'wide-angle-camera',
      'telephoto-camera',
    ],
  });

  // Track which lenses are available on this device
  const availableLenses = {
    'ultra-wide': device?.physicalDevices?.includes('ultra-wide-angle-camera') ?? false,
    'wide': device?.physicalDevices?.includes('wide-angle-camera') ?? true,
    'telephoto': device?.physicalDevices?.includes('telephoto-camera') ?? false,
  };

  // Calculate zoom based on selected lens
  const getZoomForLens = useCallback((lens: LensType): number => {
    switch (lens) {
      case 'ultra-wide':
        return 0.5; // 0.5x zoom triggers ultra-wide lens
      case 'wide':
        return 1.0; // 1x is standard wide
      case 'telephoto':
        return 2.0; // 2x for telephoto
      default:
        return 0.5;
    }
  }, []);

  const currentZoom = getZoomForLens(selectedLens);

  // Upload queue status
  const uploadQueue = useUploadQueue();

  // Toast notifications
  const { toast, showToast, hideToast } = useToast();

  // Recording state
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [segmentsRecorded, setSegmentsRecorded] = useState(0);
  const [availableSources, setAvailableSources] = useState<CameraSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('phone');
  const uvcStatus = useUvcDeviceStatus();
  const [externalHandle, setExternalHandle] = useState<string | null>(null);
  const [externalReady, setExternalReady] = useState(false);
  const [externalDeviceId, setExternalDeviceId] = useState<string | null>(null);
  const externalHandleRef = useRef<string | null>(null);
  const initialDims = Dimensions.get('window');
  const [previewContainerWidth, setPreviewContainerWidth] = useState(initialDims.width);
  const [previewContainerHeight, setPreviewContainerHeight] = useState(initialDims.height);
  const [externalResolution, setExternalResolution] = useState<{ width: number; height: number } | null>(null);
  const [showResolutionDialog, setShowResolutionDialog] = useState(false);
  const [hasShownResolutionDialog, setHasShownResolutionDialog] = useState(false);

  // Animation
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const sessionActiveRef = useRef(false);
  const segmentTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const appState = useRef(AppState.currentState);

  // Initialize upload queue service
  useEffect(() => {
    UploadQueueService.initialize();

    // Handle app state changes
    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      subscription.remove();
      if (segmentTimeoutRef.current) {
        clearTimeout(segmentTimeoutRef.current);
      }
    };
  }, []);

  // Populate camera sources (phone default, external placeholder on Android)
  useEffect(() => {
    const sources = getAvailableSources();
    setAvailableSources(sources);

    const preferred = sources.find((s) => s.type === 'phone')?.id || sources[0]?.id;
    if (preferred) {
      setSelectedSourceId(preferred);
    }
  }, []);

  const selectedSource = availableSources.find((s) => s.id === selectedSourceId);
  const isExternalSelected = selectedSource?.type === 'external';
  const externalConnected = isAndroid && uvcStatus.available && uvcStatus.connected;
  const showExternalPreview = isExternalSelected && isAndroid;
  const externalPreviewSupported = isAndroid && !!NativeUvcView && uvcStatus.available;
  const externalPreviewReady = showExternalPreview && externalPreviewSupported && uvcStatus.connected && externalReady;
  const externalRecordDisabled = isExternalSelected && !externalPreviewReady;
  const formatDimension = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : '—');
  const viewportWidthLabel = formatDimension(previewContainerWidth);
  const viewportHeightLabel = formatDimension(previewContainerHeight);
  const previewAspect = useMemo(() => {
    if (externalResolution?.width && externalResolution?.height) {
      const aspect = externalResolution.width / externalResolution.height;
      return aspect > 0 ? aspect : FIXED_PREVIEW_ASPECT;
    }
    return FIXED_PREVIEW_ASPECT;
  }, [externalResolution]);
  const previewBoxSize = useMemo(() => {
    if (previewContainerWidth <= 0 || previewContainerHeight <= 0) {
      return { width: 0, height: 0 };
    }
    return {
      width: previewContainerWidth,
      height: previewContainerHeight,
    };
  }, [previewContainerWidth, previewContainerHeight]);
  const previewContentSize = useMemo(() => {
    if (previewContainerWidth <= 0 || previewAspect <= 0) {
      return { width: 0, height: 0 };
    }
    return {
      width: previewContainerWidth,
      height: previewContainerWidth / previewAspect,
    };
  }, [previewContainerWidth, previewAspect]);
  const livePreviewWidthLabel = formatDimension(previewContentSize.width);
  const livePreviewHeightLabel = formatDimension(previewContentSize.height);
  // Prepare external camera when selected (Android only)
  useEffect(() => {
    let cancelled = false;
    if (!isExternalSelected || !isAndroid) {
      setExternalReady(false);
      setExternalHandle(null);
      externalHandleRef.current = null;
      setExternalDeviceId(null);
      setExternalResolution(null);
      setShowResolutionDialog(false);
      setHasShownResolutionDialog(false);
      return;
    }

    const closeHandle = (handle?: string | null) => {
      const target = handle ?? externalHandleRef.current;
      if (target) {
        UvcCameraModule?.close(target).catch(() => {});
      }
      externalHandleRef.current = null;
    };

    const prepareExternal = async () => {
      const startPreviewWithRetry = async (handle: string) => {
        for (let i = 0; i < 15; i++) {
          try {
            const info = await UvcCameraModule?.startPreview(handle);
            if (info?.width && info?.height && info.height !== 0) {
              setExternalResolution((prev) => {
                if (!prev || prev.width !== info.width || prev.height !== info.height) {
                  setHasShownResolutionDialog((shown) => {
                    if (!shown) {
                      setShowResolutionDialog(true);
                    }
                    return true;
                  });
                  return { width: info.width, height: info.height };
                }
                return prev;
              });
            }
            return true;
          } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
        return false;
      };

      try {
        const deviceId = uvcStatus.devices[0]?.id;
        if (!deviceId) {
          setExternalReady(false);
          return;
        }
        setExternalDeviceId(deviceId);
        await UvcCameraModule?.requestPermission(deviceId);
        const handle = await UvcCameraModule?.open(deviceId, {});
        if (!handle || cancelled) {
          setExternalReady(false);
          return;
        }
        closeHandle();
        externalHandleRef.current = handle;
        setExternalHandle(handle);
        setExternalReady(false);
        const ok = await startPreviewWithRetry(handle);
        if (!cancelled) {
          setExternalReady(ok);
        }
      } catch (e) {
        console.error('[Camera] External prepare error:', e);
        setExternalReady(false);
      }
    };

    prepareExternal();

    return () => {
      cancelled = true;
      closeHandle();
      setExternalReady(false);
    };
  }, [isExternalSelected, isAndroid, uvcStatus.devices, uvcStatus.connected]);

  // If current lens isn’t available, fall back to the first available lens
  useEffect(() => {
    if (!availableLenses[selectedLens]) {
      if (availableLenses['wide']) {
        setSelectedLens('wide');
      } else if (availableLenses['ultra-wide']) {
        setSelectedLens('ultra-wide');
      } else if (availableLenses['telephoto']) {
        setSelectedLens('telephoto');
      }
    }
  }, [availableLenses, selectedLens]);

  // Handle app going to background/foreground
  const handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (
      appState.current.match(/inactive|background/) &&
      nextAppState === 'active'
    ) {
      console.log('[Camera] App came to foreground, processing queue');
      UploadQueueService.processQueue();
    }
    appState.current = nextAppState;
  };

  // Pulse animation for recording indicator
  useEffect(() => {
    if (isRecording) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  // Timer for elapsed time
  useEffect(() => {
    if (isSessionActive) {
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isSessionActive]);

  // Track uploads and show success toast
  const prevTotal = useRef(0);
  const hasRecordedRef = useRef(false);

  useEffect(() => {
    if (segmentsRecorded > 0) {
      hasRecordedRef.current = true;
    }

    if (
      hasRecordedRef.current &&
      prevTotal.current > 0 &&
      uploadQueue.total < prevTotal.current &&
      uploadQueue.uploading === 0
    ) {
      showToast('Video saved successfully', 'success');
    }

    prevTotal.current = uploadQueue.total;
  }, [uploadQueue.total, uploadQueue.uploading, segmentsRecorded, showToast]);

  // Format time as MM:SS or HH:MM:SS
  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins
        .toString()
        .padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}`;
  };

  // Truncate address for display
  const truncateAddress = (addr: string, maxLength: number = 28): string => {
    if (!addr) return 'Unknown Location';
    return addr.length > maxLength
      ? addr.substring(0, maxLength) + '...'
      : addr;
  };

  // Handle recording stopped callback
  const onRecordingFinished = useCallback(
    async (video: VideoFile) => {
      console.log('[Camera] Segment complete:', video.path);
      setIsRecording(false);
      if (video?.path && user) {
        setSegmentsRecorded((prev) => prev + 1);

        // Convert path to file:// URI if needed
        const videoUri = video.path.startsWith('file://') 
          ? video.path 
          : `file://${video.path}`;

        await UploadQueueService.addToQueue(
          videoUri,
          locationId,
          user.uid,
          user.organizationId
        );

        // If session still active, start next segment immediately
        if (sessionActiveRef.current) {
          console.log('[Camera] Starting next segment...');
          startRecordingSegment();
        }
      }
    },
    [user, locationId]
  );

  const onRecordingError = useCallback((error: any) => {
    console.error('[Camera] Recording error:', error);
    setIsRecording(false);
    // If session active, try to recover
    if (sessionActiveRef.current) {
      setTimeout(() => startRecordingSegment(), 1000);
    }
  }, []);

  // Start recording a segment
  const startRecordingSegment = useCallback(async () => {
    if (!cameraRef.current || !sessionActiveRef.current) return;

    try {
      setIsRecording(true);
      console.log('[Camera] Recording segment...');

      cameraRef.current.startRecording({
        onRecordingFinished,
        onRecordingError,
        fileType: 'mp4',
        videoBitRate: 'high',
        videoCodec: 'h264',
      });

      // Stop after segment duration
      segmentTimeoutRef.current = setTimeout(() => {
        if (cameraRef.current && sessionActiveRef.current) {
          console.log('[Camera] Segment duration reached, stopping...');
          cameraRef.current.stopRecording();
        }
      }, SEGMENT_DURATION * 1000);
    } catch (error: any) {
      console.error('[Camera] Start recording error:', error);
      setIsRecording(false);
      if (sessionActiveRef.current) {
        setTimeout(() => startRecordingSegment(), 1000);
      }
    }
  }, [onRecordingFinished, onRecordingError]);

  const startExternalSegment = useCallback(async () => {
    const handle = externalHandleRef.current || externalHandle;
    if (!handle) {
      throw new Error('External camera not initialized. Try reconnecting the device.');
    }

    const dir = `${FileSystem.documentDirectory}uvc`;
    try {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } catch (_error) {
      // Directory may already exist
    }

    const filePath = `${dir}/${Date.now()}`;
    await UvcCameraModule?.startRecording(handle, {
      filePath,
      fps: 30,
      durationSec: SEGMENT_DURATION,
    });
    setIsRecording(true);
  }, [externalHandle]);

  useEffect(() => {
    if (!isAndroid || !UvcCameraEvents) return;
    const subAspect = UvcCameraEvents.addListener('uvcPreviewAspect', (evt: any) => {
      const width = evt?.width;
      const height = evt?.height;
      if (typeof width === 'number' && typeof height === 'number' && height > 0) {
        setExternalResolution((prev) => {
          if (!prev || prev.width !== width || prev.height !== height) {
            setHasShownResolutionDialog((shown) => {
              if (!shown) {
                setShowResolutionDialog(true);
              }
              return true;
            });
            return { width, height };
          }
          return prev;
        });
      }
    });
    return () => {
      subAspect.remove();
    };
  }, []);

  useEffect(() => {
    if (!uvcStatus.connected) {
      setHasShownResolutionDialog(false);
      setShowResolutionDialog(false);
      setExternalResolution(null);
    }
  }, [uvcStatus.connected]);

  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setPreviewContainerWidth(window.width);
      setPreviewContainerHeight(window.height);
    });
    return () => {
      // RN 0.71+ returns an event subscription with remove()
      // @ts-ignore - safe for both shapes
      sub?.remove?.();
    };
  }, []);

  const stopExternalRecording = useCallback(async () => {
    const handle = externalHandleRef.current || externalHandle;
    if (!handle || !isRecording) return;
    try {
      await UvcCameraModule?.stopRecording(handle);
    } catch (error) {
      console.error('[Camera] External stop recording error:', error);
    } finally {
      setIsRecording(false);
    }
  }, [externalHandle, isRecording]);

  // Listen for external recording events
  useEffect(() => {
    if (!isAndroid || !UvcCameraEvents) return;

    const subComplete = UvcCameraEvents.addListener('recordingComplete', async (evt: any) => {
      const filePath = evt?.filePath;
      if (!filePath || !locationId || !user) return;
      const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
      try {
        setIsRecording(false);
        setSegmentsRecorded((prev) => prev + 1);
        await UploadQueueService.addToQueue(fileUri, locationId, user.uid, user.organizationId);
        showToast('Video saved from external cam', 'success');

        if (sessionActiveRef.current) {
          await startExternalSegment();
        } else {
          setIsSessionActive(false);
        }
      } catch (e) {
        console.error('[Camera] Queue add failed for external:', e);
        sessionActiveRef.current = false;
        setIsSessionActive(false);
        Alert.alert('External camera', 'Recording stopped due to an error.');
      }
    });

    const subError = UvcCameraEvents.addListener('error', (evt: any) => {
      const message = evt?.message || 'External camera error';
      sessionActiveRef.current = false;
      setIsSessionActive(false);
      setIsRecording(false);
      Alert.alert('External camera', message);
    });

    return () => {
      subComplete.remove();
      subError.remove();
    };
  }, [isAndroid, locationId, user, showToast, startExternalSegment]);

  // Start recording session
  const startSession = async () => {
    if (selectedSource?.type === 'external') {
      if (!isAndroid) {
        Alert.alert('External camera', 'USB cameras are only supported on Android at the moment.');
        return;
      }

      if (!externalConnected) {
        Alert.alert(
          'External camera not ready',
          'Plug in your USB/OTG camera and grant permission. Preview must be visible before recording.',
        );
        return;
      }
      if (!externalReady) {
        Alert.alert('External camera not ready', 'Preview is not ready. Wait a moment and try again.');
        return;
      }

      try {
        setIsSessionActive(true);
        sessionActiveRef.current = true;
        setElapsedTime(0);
        setSegmentsRecorded(0);
        await startExternalSegment();
        return;
      } catch (e: any) {
        sessionActiveRef.current = false;
        setIsSessionActive(false);
        setIsRecording(false);
        Alert.alert('External camera', e?.message || 'Failed to start recording.');
        return;
      }
    }

    console.log('[Camera] Starting session...');
    setIsSessionActive(true);
    sessionActiveRef.current = true;
    setElapsedTime(0);
    setSegmentsRecorded(0);

    await startRecordingSegment();
  };

  // Stop recording session
  const stopSession = async () => {
    console.log('[Camera] Stopping session...');
    setIsSessionActive(false);
    sessionActiveRef.current = false;

    if (segmentTimeoutRef.current) {
      clearTimeout(segmentTimeoutRef.current);
      segmentTimeoutRef.current = null;
    }

    if (!isExternalSelected) {
      if (cameraRef.current && isRecording) {
        await cameraRef.current.stopRecording();
      }
      setIsRecording(false);
    } else {
      await stopExternalRecording();
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  // Handle record button press
  const handleRecordPress = () => {
    if (isSessionActive) {
      stopSession();
    } else {
      startSession();
    }
  };

  // Handle back/close
  const handleClose = () => {
    if (isSessionActive) {
      Alert.alert(
        'Stop Recording?',
        'This will end your session. All recorded segments are saved locally and will upload automatically.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Stop & Exit',
            style: 'destructive',
            onPress: () => {
              stopSession();
              navigation.goBack();
            },
          },
        ]
      );
    } else {
      navigation.goBack();
    }
  };

  // Handle lens change
  const handleLensChange = (lens: LensType) => {
    if (availableLenses[lens]) {
      setSelectedLens(lens);
      Haptics.selectionAsync();
    }
  };

  // Get status message
  const getStatusMessage = (): string => {
    if (isSessionActive) {
      if (segmentsRecorded === 0) {
        return 'Recording...';
      }
      return `${segmentsRecorded} segment${segmentsRecorded > 1 ? 's' : ''} saved`;
    }

    if (isExternalSelected) {
      if (!externalPreviewSupported) {
        return 'External preview unavailable on this device';
      }
      if (!uvcStatus.connected) {
        return 'Connect USB camera to begin';
      }
      if (!externalReady) {
        return 'Preparing external camera...';
      }
    }

    if (uploadQueue.total > 0) {
      if (uploadQueue.isUploading) {
        return `Uploading ${uploadQueue.uploading} of ${uploadQueue.total}...`;
      }
      if (uploadQueue.failed > 0) {
        return `${uploadQueue.failed} failed • Tap to retry`;
      }
      return `${uploadQueue.pending} pending upload${uploadQueue.pending > 1 ? 's' : ''}`;
    }

    return 'Tap to start recording';
  };

  // Get lens display text
  const getLensDisplayText = (lens: LensType): string => {
    switch (lens) {
      case 'ultra-wide':
        return '.5';
      case 'wide':
        return '1x';
      case 'telephoto':
        return '2x';
    }
  };

  // Header pill component
  const HeaderPill = ({ children }: { children: React.ReactNode }) => {
    if (Platform.OS === 'ios') {
      return (
        <BlurView intensity={60} tint="dark" style={styles.headerPill}>
          {children}
        </BlurView>
      );
    }
    return (
      <View style={[styles.headerPill, styles.headerPillAndroid]}>
        {children}
      </View>
    );
  };


  // No camera device available
  if (!device) {
    return (
      <View style={[styles.permissionContainer, { paddingTop: insets.top }]}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="transparent"
          translucent
        />
        <Ionicons name="camera-outline" size={64} color="#666" />
        <Text style={styles.permissionTitle}>No Camera Found</Text>
        <Text style={styles.permissionText}>
          Unable to access camera device.
        </Text>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backLink}
        >
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Missing location/user
  if (!locationId || !user) {
    return (
      <View style={[styles.permissionContainer, { paddingTop: insets.top }]}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="transparent"
          translucent
        />
        <Ionicons name="location-outline" size={64} color="#666" />
        <Text style={styles.permissionTitle}>Missing Information</Text>
        <Text style={styles.permissionText}>
          Location information is required to start recording.
        </Text>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backLink}
        >
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const externalOverlayIcon: keyof typeof Ionicons.glyphMap = !externalPreviewSupported
    ? 'alert-circle'
    : uvcStatus.connected
      ? 'videocam-outline'
      : 'alert-circle';
  const externalOverlayMessage = !externalPreviewSupported
    ? 'External preview is unavailable on this build/emulator.'
    : uvcStatus.connected
      ? 'Preparing preview...'
      : 'No USB camera detected. Connect one to view live preview.';
  const recordButtonDisabled = isExternalSelected ? externalRecordDisabled : false;
  const handlePreviewLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    const height = event.nativeEvent.layout.height;
    if (typeof width === 'number' && width > 0 && Math.abs(width - previewContainerWidth) > 1) {
      setPreviewContainerWidth(width);
    }
    if (typeof height === 'number' && height > 0 && Math.abs(height - previewContainerHeight) > 1) {
      setPreviewContainerHeight(height);
    }
  }, [previewContainerWidth, previewContainerHeight]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <View style={styles.previewContainer} onLayout={handlePreviewLayout}>
        {showExternalPreview ? (
          <View style={styles.externalPreviewWrapper}>
            <View style={[styles.externalPreviewBox, previewBoxSize]}>
              {externalPreviewSupported && NativeUvcView ? (
                <View
                  style={[
                    styles.externalPreviewSurface,
                    {
                      width: previewContentSize.width,
                      height: previewContentSize.height,
                    },
                  ]}
                >
                  <NativeUvcView pointerEvents="none" style={StyleSheet.absoluteFill} />
                </View>
              ) : null}
              {(!externalPreviewSupported || !uvcStatus.connected || !externalReady) && (
                <View style={[StyleSheet.absoluteFill, styles.externalPreviewOverlay]}>
                  <Ionicons name={externalOverlayIcon} size={56} color="#888" />
                  <Text style={styles.placeholderTitle}>External camera</Text>
                  <Text style={styles.placeholderText}>{externalOverlayMessage}</Text>
                </View>
              )}
            </View>
          </View>
        ) : (
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive
            video
            audio
            zoom={currentZoom}
          />
        )}
      </View>

      {/* Toasts */}
      <Toast visible={toast.visible} message={toast.message} type={toast.type} onHide={hideToast} />

      {/* Top floating header */}
      <View style={[styles.topContainer, { top: insets.top + 10 }]}>
        <HeaderPill>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.closeButton}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.locationContainer}>
            <Ionicons
              name="location"
              size={14}
              color="rgba(255,255,255,0.8)"
              style={styles.locationIcon}
            />
            <Text style={styles.addressText} numberOfLines={1}>
              {truncateAddress(address)}
            </Text>
          </View>

          {isSessionActive && (
            <Animated.View
              style={[
                styles.recordingIndicator,
                { transform: [{ scale: pulseAnim }] },
              ]}
            >
              <View style={styles.recordingDot} />
            </Animated.View>
          )}

          {/* Queue indicator when not recording */}
          {!isSessionActive && uploadQueue.total > 0 && (
            <View style={styles.queueBadge}>
              <Text style={styles.queueBadgeText}>{uploadQueue.total}</Text>
            </View>
          )}
        </HeaderPill>
      </View>

      {/* Bottom floating controls */}
      <View style={[styles.bottomContainer, { bottom: insets.bottom + 30 }]}>
        {availableSources.length > 1 && (
          <View style={styles.sourceSelector}>
            {availableSources.map((source) => (
              <TouchableOpacity
                key={source.id}
                onPress={() => setSelectedSourceId(source.id)}
                style={[
                  styles.sourceButton,
                  selectedSourceId === source.id && styles.sourceButtonActive,
                  !source.supported && styles.sourceButtonDisabled,
                ]}
                disabled={!source.supported}
              >
                <Text
                  style={[
                    styles.sourceButtonText,
                    selectedSourceId === source.id && styles.sourceButtonTextActive,
                    !source.supported && styles.sourceButtonTextDisabled,
                  ]}
                >
                  {source.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {!isExternalSelected && (
          <View style={styles.lensSelector}>
            {(['ultra-wide', 'wide', 'telephoto'] as LensType[]).map((lens) => (
              <TouchableOpacity
                key={lens}
                onPress={() => handleLensChange(lens)}
                style={[
                  styles.lensButton,
                  selectedLens === lens && styles.lensButtonActive,
                  !availableLenses[lens] && styles.lensButtonDisabled,
                ]}
                activeOpacity={0.7}
                disabled={!availableLenses[lens]}
              >
                <Text
                  style={[
                    styles.lensText,
                    selectedLens === lens && styles.lensTextActive,
                    !availableLenses[lens] && styles.lensTextDisabled,
                  ]}
                >
                  {getLensDisplayText(lens)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {isSessionActive && (
          <View style={styles.timerContainer}>
            <Text style={styles.timerText}>{formatTime(elapsedTime)}</Text>
          </View>
        )}

        <TouchableOpacity
          onPress={handleRecordPress}
          style={[
            styles.recordButtonOuter,
            recordButtonDisabled && styles.recordButtonDisabled,
          ]}
          activeOpacity={0.8}
          disabled={recordButtonDisabled}
        >
          <View
            style={[
              styles.recordButtonInner,
              isSessionActive && styles.recordButtonActive,
            ]}
          >
            {isSessionActive ? (
              <View style={styles.stopIcon} />
            ) : (
              <View style={styles.recordIcon} />
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.statusContainer}
          onPress={uploadQueue.failed > 0 ? uploadQueue.retryFailed : undefined}
          activeOpacity={uploadQueue.failed > 0 ? 0.7 : 1}
        >
          {uploadQueue.isUploading && (
            <ActivityIndicator
              size="small"
              color="rgba(255,255,255,0.8)"
              style={styles.uploadingSpinner}
            />
          )}
          <Text
            style={[
              styles.statusText,
              uploadQueue.failed > 0 && styles.statusTextWarning,
            ]}
          >
            {getStatusMessage()}
          </Text>
        </TouchableOpacity>
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={!!externalResolution && showResolutionDialog}
        onRequestClose={() => setShowResolutionDialog(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>External camera ready</Text>
            {externalResolution && (
              <Text style={styles.modalSubtitle}>
                Resolution {externalResolution.width} × {externalResolution.height}
              </Text>
            )}
            <Text style={styles.modalSubtitle}>
              Viewport {viewportWidthLabel} × {viewportHeightLabel}
            </Text>
            <Text style={styles.modalSubtitle}>
              Live preview {livePreviewWidthLabel} × {livePreviewHeightLabel}
            </Text>
            <TouchableOpacity
              style={styles.modalButton}
              onPress={() => setShowResolutionDialog(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function CameraScreen({ route, navigation }: any) {
  const { locationId, address } = route.params || {};
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const {
    hasPermission: hasCameraPermission,
    requestPermission: requestCameraPermission,
  } = useCameraPermission();
  const {
    hasPermission: hasMicPermission,
    requestPermission: requestMicPermission,
  } = useMicrophonePermission();

  const requestPermissions = useCallback(async () => {
    const cameraGranted = await requestCameraPermission();
    const micGranted = await requestMicPermission();
    return cameraGranted && micGranted;
  }, [requestCameraPermission, requestMicPermission]);

  if (hasCameraPermission === null || hasMicPermission === null) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (!hasCameraPermission || !hasMicPermission) {
    return (
      <View style={[styles.permissionContainer, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        <Ionicons name="camera-outline" size={64} color="#666" />
        <Text style={styles.permissionTitle}>Camera Access Needed</Text>
        <Text style={styles.permissionText}>
          We need camera and microphone access to record your session.
        </Text>
        <TouchableOpacity
          onPress={requestPermissions}
          style={styles.permissionButton}
          activeOpacity={0.8}
        >
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openSettings()} style={styles.backLink}>
          <Text style={styles.backLinkText}>Open Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backLink}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!locationId || !user) {
    return (
      <View style={[styles.permissionContainer, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        <Ionicons name="location-outline" size={64} color="#666" />
        <Text style={styles.permissionTitle}>Missing Information</Text>
        <Text style={styles.permissionText}>
          Location information is required to start recording.
        </Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backLink}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <CameraScreenContent
      navigation={navigation}
      locationId={locationId}
      address={address}
      insets={insets}
      user={user}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewContainer: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  externalPreviewWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  externalPreviewBox: {
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  externalPreviewSurface: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  externalPreviewOverlay: {
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 40,
  },
  placeholderTitle: {
    marginTop: 16,
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  placeholderText: {
    marginTop: 8,
    fontSize: 14,
    color: '#b3b3b3',
    textAlign: 'center',
    lineHeight: 20,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#fff',
    marginTop: 24,
    marginBottom: 12,
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  permissionButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 30,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
  },
  backLink: {
    marginTop: 24,
    padding: 10,
  },
  backLinkText: {
    fontSize: 16,
    color: '#888',
  },

  // Top header
  topContainer: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
  },
  headerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 14,
    overflow: 'hidden',
  },
  headerPillAndroid: {
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  locationContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 12,
    marginRight: 8,
  },
  locationIcon: {
    marginRight: 6,
  },
  addressText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#fff',
    flex: 1,
  },
  recordingIndicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,59,48,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff3b30',
  },
  queueBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  queueBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },

  // Bottom controls
  bottomContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },

  // Lens selector
  lensSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 22,
    padding: 3,
  },
  sourceSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sourceButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    marginHorizontal: 4,
  },
  sourceButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  sourceButtonDisabled: {
    opacity: 0.4,
  },
  sourceButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
  },
  sourceButtonTextActive: {
    color: '#FFD60A',
  },
  sourceButtonTextDisabled: {
    color: 'rgba(255,255,255,0.3)',
  },
  lensButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lensButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  lensButtonDisabled: {
    opacity: 0.3,
  },
  lensText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
  },
  lensTextActive: {
    color: '#FFD60A',
  },
  lensTextDisabled: {
    color: 'rgba(255,255,255,0.3)',
  },

  timerContainer: {
    marginBottom: 24,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  timerText: {
    fontSize: 28,
    fontWeight: '600',
    color: '#fff',
    fontVariant: ['tabular-nums'],
    ...Platform.select({
      ios: {
        fontFamily: 'Helvetica Neue',
      },
      android: {
        fontFamily: 'sans-serif-medium',
      },
    }),
  },
  recordButtonOuter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  recordButtonInner: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  recordIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ff3b30',
  },
  stopIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: '#ff3b30',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  uploadingSpinner: {
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.5,
        shadowRadius: 3,
      },
      android: {
        textShadowColor: 'rgba(0,0,0,0.6)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 4,
      },
    }),
  },
  statusTextWarning: {
    color: '#FFD60A',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#111',
    borderRadius: 18,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  modalSubtitle: {
    marginTop: 10,
    fontSize: 15,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
  },
  modalButton: {
    marginTop: 20,
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 36,
    paddingVertical: 10,
  },
  modalButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
  },
});

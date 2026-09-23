import { launchCamera } from 'react-native-image-picker';

export interface CapturedPhoto {
  readonly uri: string;
  readonly fileName: string;
  readonly type: string;
}

export type CapturePhotoResult =
  | { readonly status: 'captured'; readonly photo: CapturedPhoto }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly message: string };

export async function capturePhoto(): Promise<CapturePhotoResult> {
  const result = await launchCamera({ mediaType: 'photo', saveToPhotos: false, quality: 0.8 });

  if (result.didCancel) return { status: 'cancelled' };
  if (result.errorCode) {
    return { status: 'error', message: result.errorMessage ?? result.errorCode };
  }

  const asset = result.assets?.[0];
  if (!asset?.uri) {
    return { status: 'error', message: 'No photo was captured' };
  }

  return {
    status: 'captured',
    photo: {
      uri: asset.uri,
      fileName: asset.fileName ?? `photo-${Date.now()}.jpg`,
      type: asset.type ?? 'image/jpeg',
    },
  };
}

import * as Keychain from 'react-native-keychain';

/**
 * This app installation's identity for push registration. The backend keeps one PUSH entry per
 * installation (personnel-service pushTokens/pushDevices.ts), so a member signed in on a phone
 * and a tablet is paged on both, and signing out of one removes only that one.
 *
 * Kept in the keychain under its own service - never cleared by sign-out, which resets only the
 * auth credentials - so re-signing in on the same device rotates its entry instead of adding a
 * second one. If the keychain is unavailable the id lives for this process only: registration
 * still works, and the worst case is one extra entry until the backend's device cap evicts it.
 */
const SERVICE = 'boxalarm-device-installation';
const ACCOUNT = 'installation-id';

let cached: string | null = null;

function newInstallationId(): string {
  // Not a secret, only unique per installation: 128 random bits in UUID v4 form.
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export async function getDeviceInstallationId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) {
      cached = stored.password;
      return cached;
    }
  } catch {
    // Fall through: generate one for this process.
  }
  const id = newInstallationId();
  cached = id;
  try {
    await Keychain.setGenericPassword(ACCOUNT, id, { service: SERVICE });
  } catch {
    // Keychain unavailable: keep the in-memory id.
  }
  return id;
}

/** Test seam: forget the cached id. */
export function resetDeviceInstallationIdCache(): void {
  cached = null;
}

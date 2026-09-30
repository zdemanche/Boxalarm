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
/**
 * Stored THIS_DEVICE_ONLY (review N-M1): an iOS backup restore or Quick Start transfer must not
 * copy the id to a new phone, or two phones - often two members of one department - would share
 * an installation id. Its own service, so an id stored before this (default accessibility, which
 * does migrate) is moved into it once, keeping this device's id.
 */
const SERVICE = 'boxalarm-device-installation-v2';
const LEGACY_SERVICE = 'boxalarm-device-installation';
const ACCOUNT = 'installation-id';
const DEVICE_ONLY = { accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

let cached: string | null = null;

function newInstallationId(): string {
  // Not a secret, only unique per installation: 128 random bits in UUID v4 form.
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function store(id: string): Promise<boolean> {
  try {
    await Keychain.setGenericPassword(ACCOUNT, id, { service: SERVICE, ...DEVICE_ONLY });
    return true;
  } catch {
    // Keychain unavailable: keep the in-memory id.
    return false;
  }
}

export async function getDeviceInstallationId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await Keychain.getGenericPassword({ service: SERVICE });
    if (stored && stored.password) {
      cached = stored.password;
      return cached;
    }
    // One-time move of an id kept before it was device-only.
    const legacy = await Keychain.getGenericPassword({ service: LEGACY_SERVICE });
    if (legacy && legacy.password) {
      cached = legacy.password;
      if (await store(legacy.password)) {
        await Keychain.resetGenericPassword({ service: LEGACY_SERVICE }).catch(() => false);
      }
      return cached;
    }
  } catch {
    // Fall through: generate one for this process.
  }
  const id = newInstallationId();
  cached = id;
  await store(id);
  return id;
}

/** Test seam: forget the cached id. */
export function resetDeviceInstallationIdCache(): void {
  cached = null;
}

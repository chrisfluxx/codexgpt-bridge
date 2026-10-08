export type ReleasePlatform = "win32" | "darwin" | "linux";
export type ReleaseArch = "x64" | "arm64";
export type ReleaseArtifactKind = "nsis" | "dmg" | "zip" | "appimage" | "deb";

export interface ReleaseArtifact {
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArch;
  readonly kind: ReleaseArtifactKind;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly url: string;
}

export interface ReleaseManifestSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly publishedAt: string;
  readonly artifacts: readonly ReleaseArtifact[];
  readonly signature?: ReleaseManifestSignature;
}

export interface ReleaseUpdateStatus {
  readonly phase:
    | "unconfigured"
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "failed";
  readonly currentVersion: string;
  readonly manifestUrl?: string;
  readonly manifestPath?: string;
  readonly availableVersion?: string;
  readonly artifact?: ReleaseArtifact;
  readonly downloadedPath?: string;
  readonly checkedAt?: string;
  readonly manifestSignatureVerified?: boolean;
  readonly manifestKeyId?: string;
  readonly error?: string;
}

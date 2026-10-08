export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly label: string;
  readonly detail: string;
  readonly repairable: boolean;
}

export interface DesktopDoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly overall: "healthy" | "attention" | "broken";
  readonly checks: readonly DoctorCheck[];
  readonly privacy: {
    readonly promptsIncluded: false;
    readonly responsesIncluded: false;
    readonly credentialsIncluded: false;
    readonly rawAccountIdentityIncluded: false;
    readonly absoluteHomePathsIncluded: false;
  };
}

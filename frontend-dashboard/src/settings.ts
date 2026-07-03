const STORAGE_KEY = "scheduler-dashboard-settings";

/**
 * Mirrors backend-api's MOCK_AUTH dev fallback: there's no login UI yet, so
 * the dashboard authenticates by sending these as x-mock-* headers. See
 * backend-api's README section on auth for the server-side half of this.
 */
export interface DashboardSettings {
  organizationId: string;
  userId: string;
  projectId: string;
}

const DEFAULTS: DashboardSettings = { organizationId: "", userId: "dashboard-user", projectId: "" };

export function loadSettings(): DashboardSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DashboardSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: DashboardSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isConfigured(settings: DashboardSettings): boolean {
  return settings.organizationId.trim() !== "" && settings.projectId.trim() !== "";
}

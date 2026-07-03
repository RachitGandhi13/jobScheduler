import { useCallback, useState } from "react";
import { loadSettings, saveSettings, type DashboardSettings } from "../settings";

export function useSettings() {
  const [settings, setSettings] = useState<DashboardSettings>(() => loadSettings());

  const update = useCallback((next: Partial<DashboardSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      saveSettings(merged);
      return merged;
    });
  }, []);

  return { settings, update };
}

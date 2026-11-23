export type Theme = "auto" | "light" | "dark";
export const THEME_KEY = "compass.theme";

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch { return "auto"; }
}

export function applyTheme(theme: Theme) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

// Loaded separately in the head so the saved preference precedes the app.
if (typeof document !== "undefined") applyTheme(readTheme());

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";
export type Role = "Viewer" | "Engineer" | "Approver";

interface UiState {
  theme: Theme;
  role: Role;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setRole: (role: Role) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: "light",
      role: "Engineer",
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === "light" ? "dark" : "light" }),
      setRole: (role) => set({ role }),
    }),
    { name: "pre-ui-state" }
  )
);

export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var raw = localStorage.getItem("pre-ui-state");
    var theme = raw ? JSON.parse(raw).state.theme : "light";
    if (theme === "dark") document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;

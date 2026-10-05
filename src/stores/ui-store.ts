import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * UI chrome state. Colour theme is owned by `next-themes` (class strategy on <html>); this
 * store holds the layout preferences that must survive navigation and reloads.
 */
export interface UiState {
  /** Desktop sidebar collapsed to icons only. Persisted. */
  sidebarCollapsed: boolean
  /** Mobile drawer (Sheet) open. */
  mobileNavOpen: boolean
  /** ⌘K palette open. */
  commandPaletteOpen: boolean

  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setMobileNavOpen: (open: boolean) => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
}

export const UI_STORE_KEY = 'marmot:ui'

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      mobileNavOpen: false,
      commandPaletteOpen: false,

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
    }),
    {
      name: UI_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
      // Hydrate after mount (see AppShell) so server and first client render match.
      skipHydration: true,
    },
  ),
)

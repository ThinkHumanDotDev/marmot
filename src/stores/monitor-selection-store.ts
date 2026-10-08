import { create } from 'zustand'

/**
 * Selection of the monitor list (#124) and the hand-off from the command palette to the list
 * ("Search monitors", bulk actions on the selection). Not persisted: a selection belongs to the
 * page it was made on. The list keeps it a subset of the monitors it shows (`retain`).
 */

/** Bulk actions the command palette can start on the list's selection. */
export type PaletteBulkAction = 'pause' | 'resume' | 'check' | 'delete'

export interface MonitorSelectionState {
  selected: Record<string, true>
  /** Last row toggled without Shift: one end of a Shift range. */
  anchor: string | null
  /** The list is on screen (the palette offers its actions only then). */
  listMounted: boolean
  /** The palette asked the list to focus its search box. */
  searchFocusPending: boolean
  /** The palette asked the list to run a bulk action on the selection. */
  bulkRequest: PaletteBulkAction | null

  toggle: (id: string) => void
  /** Selects (or clears) every row between the anchor and `id` in `ordered`. */
  selectRange: (id: string, ordered: readonly string[], value?: boolean) => void
  setMany: (ids: readonly string[], value: boolean) => void
  /** Drops selected ids that are not in `visible`. */
  retain: (visible: readonly string[]) => void
  clear: () => void

  setListMounted: (mounted: boolean) => void
  requestSearchFocus: () => void
  takeSearchFocus: () => boolean
  requestBulk: (action: PaletteBulkAction) => void
  takeBulkRequest: () => PaletteBulkAction | null
}

export const useMonitorSelection = create<MonitorSelectionState>()((set, get) => ({
  selected: {},
  anchor: null,
  listMounted: false,
  searchFocusPending: false,
  bulkRequest: null,

  toggle: (id) =>
    set((s) => {
      const selected = { ...s.selected }
      if (selected[id]) delete selected[id]
      else selected[id] = true
      return { selected, anchor: id }
    }),

  selectRange: (id, ordered, value = true) =>
    set((s) => {
      const to = ordered.indexOf(id)
      if (to === -1) return {}
      const anchorIndex = s.anchor === null ? -1 : ordered.indexOf(s.anchor)
      const from = anchorIndex === -1 ? to : anchorIndex
      const selected = { ...s.selected }
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (value) selected[ordered[i]] = true
        else delete selected[ordered[i]]
      }
      return { selected, anchor: anchorIndex === -1 ? id : s.anchor }
    }),

  setMany: (ids, value) =>
    set((s) => {
      const selected = { ...s.selected }
      for (const id of ids) {
        if (value) selected[id] = true
        else delete selected[id]
      }
      return { selected }
    }),

  retain: (visible) =>
    set((s) => {
      const keep = new Set(visible)
      const ids = Object.keys(s.selected)
      if (ids.every((id) => keep.has(id))) return {}
      const selected: Record<string, true> = {}
      for (const id of ids) if (keep.has(id)) selected[id] = true
      return { selected, anchor: s.anchor && keep.has(s.anchor) ? s.anchor : null }
    }),

  clear: () => set({ selected: {}, anchor: null }),

  setListMounted: (listMounted) => set({ listMounted }),
  requestSearchFocus: () => set({ searchFocusPending: true }),
  takeSearchFocus: () => {
    const pending = get().searchFocusPending
    if (pending) set({ searchFocusPending: false })
    return pending
  },
  requestBulk: (bulkRequest) => set({ bulkRequest }),
  takeBulkRequest: () => {
    const request = get().bulkRequest
    if (request) set({ bulkRequest: null })
    return request
  },
}))

/** Number of selected monitors. */
export const selectSelectionCount = (s: MonitorSelectionState) => Object.keys(s.selected).length

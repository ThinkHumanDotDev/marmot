'use client'

/**
 * Runs `fn` once no modal dialog is open any more (or after `timeoutMs`). A dialog that closes
 * hands the focus back to the element that opened it when its exit animation ends, so an action
 * started from the command palette that moves the focus (or opens another dialog) waits for that.
 * Returns a cancel function.
 */
export function afterDialogsClose(fn: () => void, timeoutMs = 1500): () => void {
  const started = Date.now()
  let frame = 0
  const tick = () => {
    const open = document.querySelector('[role="dialog"], [role="alertdialog"]')
    if (!open || Date.now() - started > timeoutMs) {
      // One more frame: the focus is restored right after the dialog leaves the DOM.
      frame = requestAnimationFrame(fn)
      return
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

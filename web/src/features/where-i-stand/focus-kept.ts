import { useLayoutEffect } from "react";

export function useFocusKeptWhenItsControlLeaves(controlTakingFocus: () => HTMLElement | null) {
  const focusedBeforeThisRender = document.activeElement;
  useLayoutEffect(() => {
    const focusFellToTheBody = document.activeElement === document.body && focusedBeforeThisRender?.isConnected === false;
    if (focusFellToTheBody) controlTakingFocus()?.focus();
  });
}

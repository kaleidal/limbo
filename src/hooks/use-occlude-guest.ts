import { useLayoutEffect, useRef } from "react";
import { useAppStore } from "@/store/app-store";

/** Wait for the native guest snapshot handoff before rendering an HTML overlay. */
export function useOccludeGuest(open: boolean) {
  const wasOpen = useRef(false);
  const pushGuestOcclusion = useAppStore((state) => state.pushGuestOcclusion);
  const popGuestOcclusion = useAppStore((state) => state.popGuestOcclusion);
  const depth = useAppStore((state) => state.guestOcclusionDepth);
  const ready = useAppStore((state) => state.guestOcclusionReady);

  const opening = open && !wasOpen.current;

  useLayoutEffect(() => {
    wasOpen.current = open;
    if (!open) return;
    pushGuestOcclusion();
    return () => popGuestOcclusion();
  }, [open, pushGuestOcclusion, popGuestOcclusion]);

  return !open || (!opening && depth > 0 && ready);
}

import { useEffect } from "react";
import { useAppStore } from "@/store/app-store";

/** Let HTML overlays cover composition-hosted guests without hiding them. */
export function useOccludeGuest(open: boolean) {
  const pushGuestOcclusion = useAppStore((state) => state.pushGuestOcclusion);
  const popGuestOcclusion = useAppStore((state) => state.popGuestOcclusion);
  const depth = useAppStore((state) => state.guestOcclusionDepth);
  const ready = useAppStore((state) => state.guestOcclusionReady);

  useEffect(() => {
    if (!open) return;
    pushGuestOcclusion();
    return () => popGuestOcclusion();
  }, [open, pushGuestOcclusion, popGuestOcclusion]);

  return !open || (depth > 0 && ready);
}

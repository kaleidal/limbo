import { useEffect } from "react";
import { useAppStore } from "@/store/app-store";

/** Let HTML overlays cover composition-hosted guests without hiding them. */
export function useOccludeGuest(open: boolean) {
  const pushGuestOcclusion = useAppStore((state) => state.pushGuestOcclusion);
  const popGuestOcclusion = useAppStore((state) => state.popGuestOcclusion);

  useEffect(() => {
    if (!open) return;
    pushGuestOcclusion();
    return () => popGuestOcclusion();
  }, [open, pushGuestOcclusion, popGuestOcclusion]);
}

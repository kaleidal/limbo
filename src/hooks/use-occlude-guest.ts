import { useEffect } from "react";
import { useAppStore } from "@/store/app-store";

/** Hide native guest webviews while a React overlay is open (HWND airspace). */
export function useOccludeGuest(open: boolean) {
  const pushGuestOcclusion = useAppStore((state) => state.pushGuestOcclusion);
  const popGuestOcclusion = useAppStore((state) => state.popGuestOcclusion);

  useEffect(() => {
    if (!open) return;
    pushGuestOcclusion();
    return () => popGuestOcclusion();
  }, [open, pushGuestOcclusion, popGuestOcclusion]);
}

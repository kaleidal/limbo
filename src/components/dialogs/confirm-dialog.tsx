import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent
        size="sm"
        className="border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <AlertDialogHeader className="place-items-start px-5 pt-5 text-left">
          <AlertDialogTitle className="text-base font-semibold text-neutral-50">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-6 text-neutral-400">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex flex-row justify-end gap-2 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
          <AlertDialogCancel size="default">Cancel</AlertDialogCancel>
          <AlertDialogAction size="default" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

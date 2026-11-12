"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/**
 * Accessible modal built on the native <dialog> element:
 * focus trap, Esc to close and inert background come from the browser.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes it
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border bg-card p-0 text-card-foreground shadow-card backdrop:bg-brand-night/60 backdrop:backdrop-blur-sm open:animate-pop-in",
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="break-words text-xl font-bold sm:text-2xl">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-2 grid size-11 shrink-0 place-items-center rounded-full text-primary transition-colors hover:bg-accent"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        {children}
        {footer ? (
          // Stays in reach while long content scrolls; on phones the buttons stack full width, main action on top.
          <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-col-reverse gap-3 rounded-b-3xl bg-card px-6 pb-6 pt-3 sm:flex-row sm:flex-wrap sm:justify-end">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}

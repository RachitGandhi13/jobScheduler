import { useEffect, useState } from "react";
import { CheckIcon } from "./icons";

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

/** Auto-dismissing success notification, slides up + fades in on mount, fades out before unmount. */
export function Toast({ message, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showTimer = setTimeout(() => setVisible(true), 10);
    const hideTimer = setTimeout(() => setVisible(false), 2400);
    const dismissTimer = setTimeout(onDismiss, 2700);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearTimeout(dismissTimer);
    };
  }, [onDismiss]);

  return (
    <div
      className={`fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-espresso py-2 pr-4.5 pl-2.5 text-sm font-medium text-sand shadow-[0_16px_40px_-12px_rgba(32,17,8,0.5)] transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
      role="status"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sage/90">
        <CheckIcon className="h-3 w-3 text-espresso" strokeWidth={3} />
      </span>
      {message}
    </div>
  );
}

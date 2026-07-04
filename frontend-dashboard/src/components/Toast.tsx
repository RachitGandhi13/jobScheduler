import { useEffect, useState } from "react";

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
      className={`fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-olive px-4 py-2 text-sm font-medium text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
      role="status"
    >
      {message}
    </div>
  );
}

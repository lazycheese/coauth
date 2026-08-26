import { useEffect } from "react";
import { useCoAuth } from "../store/coauthStore";

export function Toast() {
  const toast = useCoAuth((s) => s.toast);
  const setToast = useCoAuth((s) => s.setToast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast, setToast]);
  if (!toast) return null;
  return (
    <div className="toast" role="alert" data-testid="toast" onClick={() => setToast(null)}>
      {toast}
    </div>
  );
}

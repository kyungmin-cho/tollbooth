import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import { api, errorText } from "./api";
import { finalStates } from "./state";
export function useSnapshot(id: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState(0),
    [loading, setLoading] = useState(true);
  const latest = useRef<Snapshot | undefined>(undefined),
    mounted = useRef(true);
  const accept = useCallback((s: Snapshot) => {
    if (!mounted.current) return;
    if (!latest.current || s.version >= latest.current.version) {
      latest.current = s;
      setSnapshot(s);
      setUpdated(Date.now());
      setError("");
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      accept(await api<Snapshot>("/api/sessions/" + id));
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [id, accept]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let failures = 0;
    const tick = async () => {
      if (stopped || finalStates.includes(latest.current?.state ?? "")) return;
      if (document.visibilityState === "visible") {
        await refresh();
        failures++;
      }
      if (!stopped && !finalStates.includes(latest.current?.state ?? "")) {
        const delay =
          latest.current?.state === "ACTIVE"
            ? 5000
            : Math.min(30000, 5000 * 2 ** Math.min(failures, 3));
        timer = setTimeout(tick, delay);
      }
    };
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        !finalStates.includes(latest.current?.state ?? "")
      ) {
        clearTimeout(timer);
        failures = 0;
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { snapshot, accept, error, setError, updated, loading, refresh };
}

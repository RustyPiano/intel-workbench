import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  getJobStatus,
  startJob,
  type ApiJob,
} from "../../../api";

export type JobKind = ApiJob["kind"];

export function useExtractionJob(
  caseId: string,
  kind: JobKind,
  onDone: () => void,
): { job: ApiJob | null; error: string | null; start: () => void; cancel: () => void } {
  const [job, setJob] = useState<ApiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const jobRef = useRef<ApiJob | null>(null);
  const onDoneRef = useRef(onDone);
  const notifiedDoneJobRef = useRef<string | null>(null);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const clearPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const applyJob = useCallback((next: ApiJob) => {
    if (!aliveRef.current) return;
    const previous = jobRef.current;
    jobRef.current = next;
    setJob(next);
    if (next.state === "done") {
      clearPolling();
      if (previous?.state !== "done" && notifiedDoneJobRef.current !== next.id) {
        notifiedDoneJobRef.current = next.id;
        onDoneRef.current();
      }
      return;
    }
    if (next.state === "error" || next.state === "cancelled") {
      clearPolling();
      if (next.state === "error") setError(next.error ?? "任务失败");
    }
  }, [clearPolling]);

  const pollOnce = useCallback(async () => {
    if (!caseId) return;
    const generation = generationRef.current;
    try {
      const next = await getJobStatus(caseId, kind);
      if (!aliveRef.current || generation !== generationRef.current || !next) return;
      applyJob(next);
    } catch (e) {
      if (!aliveRef.current || generation !== generationRef.current) return;
      clearPolling();
      setError((e as Error).message);
    }
  }, [applyJob, caseId, clearPolling, kind]);

  const startPolling = useCallback(() => {
    clearPolling();
    timerRef.current = setInterval(() => {
      void pollOnce();
    }, 2000);
  }, [clearPolling, pollOnce]);

  useEffect(() => {
    aliveRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearPolling();
    jobRef.current = null;
    notifiedDoneJobRef.current = null;
    setJob(null);
    setError(null);
    if (caseId) {
      void (async () => {
        try {
          const existing = await getJobStatus(caseId, kind);
          if (!aliveRef.current || generation !== generationRef.current) return;
          if (existing?.state === "running") {
            applyJob(existing);
            startPolling();
          } else if (existing) {
            jobRef.current = existing;
            setJob(existing);
            if (existing.state === "error") setError(existing.error ?? "任务失败");
          }
        } catch (e) {
          if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
        }
      })();
    }
    return () => {
      aliveRef.current = false;
      clearPolling();
    };
  }, [applyJob, caseId, clearPolling, kind, startPolling]);

  const start = useCallback(() => {
    if (!caseId || jobRef.current?.state === "running") return;
    const generation = generationRef.current;
    void (async () => {
      clearPolling();
      setError(null);
      try {
        const next = await startJob(caseId, kind);
        if (!aliveRef.current || generation !== generationRef.current) return;
        applyJob(next);
        if (next.state === "running") startPolling();
      } catch (e) {
        if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
      }
    })();
  }, [applyJob, caseId, clearPolling, kind, startPolling]);

  const cancel = useCallback(() => {
    if (!caseId || jobRef.current?.state !== "running") return;
    const generation = generationRef.current;
    void (async () => {
      setError(null);
      try {
        await cancelJob(caseId, kind);
        if (aliveRef.current && generation === generationRef.current && jobRef.current?.state === "running" && !timerRef.current) startPolling();
      } catch (e) {
        if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
      }
    })();
  }, [caseId, kind, startPolling]);

  return { job, error, start, cancel };
}

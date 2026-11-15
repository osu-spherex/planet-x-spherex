// Web Worker for the velocity search (role P, task P-04).
//
// velocityGrid() takes ~1-5 s and falseAlarm() n times that. JavaScript runs one thing at a time
// per thread: on the page's main thread that would freeze scrolling, clicks and the progress bar
// until it is done. In a worker it runs on its own thread and the page stays responsive; the
// worker only talks to the page through messages (run.ts).
//
// The message handler is a plain function so tests can run it without a real worker.

import { velocityGrid, type GridOptions, type GridResult } from "./grid";
import { falseAlarm, type FalseAlarmResult, type SignificanceOptions } from "./significance";
import type { StackableCube } from "./stack";

export type WorkerJob =
  | { kind: "grid"; options: Omit<GridOptions, "onProgress"> }
  | { kind: "falseAlarm"; n: number; options: Omit<SignificanceOptions, "onProgress"> };

export interface WorkerRequest {
  id: number;
  cube: StackableCube;
  job: WorkerJob;
}

export type WorkerReply =
  | { id: number; type: "progress"; done: number; total: number }
  | { id: number; type: "grid"; result: GridResult }
  | { id: number; type: "falseAlarm"; result: FalseAlarmResult }
  | { id: number; type: "error"; message: string };

export type Post = (reply: WorkerReply, transfer?: Transferable[]) => void;

/** Buffers of a grid result that can be moved to the page instead of copied. */
function gridBuffers(r: GridResult): Transferable[] {
  const s = r.bestStack;
  return [r.score.buffer, s.image.buffer, s.count.buffer, s.noise.buffer, s.snr.buffer] as Transferable[];
}

/** Run one request and post its progress and result (or error). */
export function handleRequest(req: WorkerRequest, post: Post): void {
  const { id, cube, job } = req;
  const onProgress = (done: number, total: number) => post({ id, type: "progress", done, total });
  try {
    if (job.kind === "grid") {
      const result = velocityGrid(cube, { ...job.options, onProgress });
      post({ id, type: "grid", result }, gridBuffers(result));
    } else if (job.kind === "falseAlarm") {
      const result = falseAlarm(cube, job.n, { ...job.options, onProgress });
      post({ id, type: "falseAlarm", result }, [result.grid.score.buffer as Transferable]);
    } else {
      throw new Error(`unknown job ${(job as { kind: unknown }).kind}`);
    }
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

// Wire up only when this file runs as a worker (not when a test imports it).
interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const WorkerGlobal = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
if (typeof WorkerGlobal === "function" && globalThis instanceof WorkerGlobal) {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = (e) => handleRequest(e.data, (reply, transfer) => scope.postMessage(reply, transfer ?? []));
}

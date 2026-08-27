export type Task =
  | { kind: "mine"; blockName?: string }
  | { kind: "farm" }
  | { kind: "guard" };

export type TaskState = "idle" | "mining" | "farming" | "guarding";

export class TaskQueue {
  private readonly pendingTasks: Task[] = [];
  private activeTask: Task | undefined;
  private stopVersion = 0;

  get current(): Task | undefined {
    return this.activeTask;
  }

  get pending(): readonly Task[] {
    return this.pendingTasks;
  }

  get state(): TaskState {
    if (!this.activeTask) return "idle";
    const states: Record<Task["kind"], Exclude<TaskState, "idle">> = {
      mine: "mining",
      farm: "farming",
      guard: "guarding",
    };
    return states[this.activeTask.kind];
  }

  enqueue(task: Task): number {
    this.pendingTasks.push(task);
    return this.pendingTasks.length;
  }

  takeNext(): Task | undefined {
    const next = this.pendingTasks.shift();
    this.activeTask = next;
    return next;
  }

  finishCurrent(): void {
    this.activeTask = undefined;
  }

  stop(): number {
    this.pendingTasks.length = 0;
    this.activeTask = undefined;
    this.stopVersion += 1;
    return this.stopVersion;
  }

  get cancellationVersion(): number {
    return this.stopVersion;
  }

  wasCancelled(version: number): boolean {
    return version !== this.stopVersion;
  }
}
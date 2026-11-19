import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { TasksRead } from "./tasks-read";

export default async function Tasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed by room alone, so a refresh after a command keeps the screen up while it reads. Opening a Sheet reads nothing here.
  return (
    <Suspense key={id} fallback={<TasksLoading />}>
      <TasksRead id={id} />
    </Suspense>
  );
}

function TasksLoading() {
  return (
    <section className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <p role="status" className="text-muted-foreground">
        Loading tasks
      </p>
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </section>
  );
}

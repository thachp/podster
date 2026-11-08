import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactsRead } from "./artifacts-read";

export default async function Artifacts({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed by room alone, so opening a task's Sheet from here keeps the screen up while it reads.
  return (
    <Suspense key={id} fallback={<ArtifactsLoading />}>
      <ArtifactsRead id={id} />
    </Suspense>
  );
}

function ArtifactsLoading() {
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Artifacts</h1>
      <p role="status" className="text-muted-foreground">
        Loading expected outputs
      </p>
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    </section>
  );
}

import { WatchForm } from "../WatchForm";

export default function NewWatchPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">New saved search</h1>
      <WatchForm />
    </div>
  );
}

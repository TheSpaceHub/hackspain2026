import { TestCallView } from '@/components/test-call-view';
import { useTestCall } from '@/hooks/use-test-call';

export function App() {
  const call = useTestCall();

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="text-sm font-semibold tracking-tight">Agent la L · Softphone</h1>
      </header>
      <main className="min-h-0 flex-1">
        <TestCallView call={call} />
      </main>
    </div>
  );
}

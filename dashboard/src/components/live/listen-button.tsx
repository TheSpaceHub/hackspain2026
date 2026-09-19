import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listenUrl } from '@/lib/agent/client';
import { Button } from '@/components/ui/button';
import type { AgentMode } from '@/lib/agent/origin';

interface ListenButtonProps {
  mode: AgentMode;
  id: string;
  live?: boolean;
}

export function ListenButton({ mode, id, live = true }: ListenButtonProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    setListening(false);
  }, [id, live]);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setListening((value) => !value)}
        aria-pressed={listening}
      >
        {listening ? <VolumeX /> : <Volume2 />}
        {listening ? 'Stop' : 'Listen'}
      </Button>
      {listening && <audio autoPlay src={listenUrl(mode, id)} className="hidden" />}
    </div>
  );
}

import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listenUrl } from '@/lib/agent/client';
import { Button } from '@/components/ui/button';

interface ListenButtonProps {
  id: string;
}

export function ListenButton({ id }: ListenButtonProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    setListening(false);
  }, [id]);

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
      {listening && <audio autoPlay src={listenUrl(id)} className="hidden" />}
    </div>
  );
}

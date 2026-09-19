import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

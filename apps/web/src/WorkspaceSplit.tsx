import { useState, type CSSProperties, type ReactNode } from 'react';

export function WorkspaceSplit({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(36);
  return (
    <div className="workspace-split" style={{ '--inspector-width': `${width}%` } as CSSProperties}>
      {children}
      <div
        className="workspace-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize incident inspector"
        aria-orientation="vertical"
        aria-valuemin={26}
        aria-valuemax={52}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setWidth((value) =>
              Math.max(26, Math.min(52, value + (event.key === 'ArrowLeft' ? 2 : -2))),
            );
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const box = event.currentTarget.parentElement!.getBoundingClientRect();
          setWidth(Math.max(26, Math.min(52, ((box.right - event.clientX) / box.width) * 100)));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <span />
      </div>
    </div>
  );
}

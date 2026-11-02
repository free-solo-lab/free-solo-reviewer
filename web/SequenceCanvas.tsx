import React from 'react';

export function SequenceCanvas({
  width,
  height,
  headerHeight,
  header,
  topInset = 0,
  children,
}: {
  width: number;
  height: number;
  headerHeight: number;
  header: React.ReactNode;
  topInset?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="sequence-canvas"
      style={
        {
          width,
          height: height - topInset,
          '--sequence-top-inset': `${topInset}px`,
        } as React.CSSProperties
      }
    >
      <div className="sequence-sticky-header" style={{ height: headerHeight - topInset }}>
        <svg
          width={width}
          height={headerHeight - topInset}
          viewBox={`0 ${topInset} ${width} ${headerHeight - topInset}`}
          role="group"
          aria-label="Участники диаграммы"
        >
          {header}
        </svg>
      </div>
      {children}
    </div>
  );
}

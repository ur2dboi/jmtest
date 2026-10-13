'use client';

import React from 'react';
import type { TreeCell } from '@/lib/engine/tree';
import type { Position } from '@/lib/types';

export interface SlotInfo {
  allowed: boolean;
  hint: 'REGISTER' | 'SPILLOVER' | 'LOCKED_3_9' | 'LOCKED_RIGHT';
  label: string;
}

const POSITIONS: Position[] = ['L', 'C', 'R'];
const EMPTY_LABEL: Record<Position, string> = {
  L: 'Left Downline Empty',
  C: 'Center Downline Empty',
  R: 'Right Downline Empty',
};

function rankClass(rank: string): string {
  const n = (rank || '').replace(/\s+/g, '').toLowerCase();
  return n.includes('starpremium') ? 'rank-starpremium' : 'rank-premium';
}

function NodeLabel({ cell }: { cell: TreeCell }) {
  if (cell.type === 'MA') {
    return (
      <strong style={{ fontSize: 15, color: '#d97706' }}>
        M.A - {(cell.rank || 'PREMIUM').toUpperCase()}
      </strong>
    );
  }
  const cNum = cell.position === 'L' ? '1' : cell.position === 'C' ? '2' : '3';
  return (
    <strong className="blue-txt">
      CA{cNum} - {(cell.rank || 'PREMIUM').toUpperCase()}
    </strong>
  );
}

function UserGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 34, height: 34, color: '#fff' }} aria-hidden>
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
    </svg>
  );
}

function SlotNode({
  parentId,
  pos,
  info,
  onSlotClick,
}: {
  parentId: number;
  pos: Position;
  info?: SlotInfo;
  onSlotClick?: (parentId: number, pos: Position) => void;
}) {
  const allowed = !!info?.allowed;
  const spill = info?.hint === 'SPILLOVER';
  const border = allowed ? (spill ? '#8b5cf6' : '#10b981') : '#9ca3af';
  const hint = !info
    ? ''
    : info.hint === 'REGISTER'
      ? '✅ CLICK TO REGISTER'
      : info.hint === 'SPILLOVER'
        ? '🔗 SPILLOVER SLOT'
        : info.hint === 'LOCKED_RIGHT'
          ? 'RIGHT SPILLOVER ONLY'
          : 'COMPLETE 3+9 FIRST';
  return (
    <li>
      <div
        className="node-wrap empty-wrap"
        onClick={allowed && onSlotClick ? () => onSlotClick(parentId, pos) : undefined}
        style={allowed ? { cursor: 'pointer' } : undefined}
        title={allowed ? 'Click to place here' : hint}
      >
        <div className="node-lbl-top">
          <strong className="blue-txt" style={{ fontSize: 13 }}>
            {info?.label || EMPTY_LABEL[pos]}
          </strong>
          <span style={{ fontSize: 10, color: allowed ? border : '#ef4444', fontWeight: 700, display: 'block' }}>
            {hint}
          </span>
        </div>
        <div
          className="tree-node-circle empty"
          style={{
            border: `3px dashed ${border}`,
            background: '#f3f4f6',
            color: '#9ca3af',
            animation: allowed ? 'mjpulse 2s infinite' : undefined,
          }}
        >
          <UserGlyph />
        </div>
      </div>
    </li>
  );
}

function CellNode({
  cell,
  depth,
  slotStates,
  onSlotClick,
  onNodeClick,
}: {
  cell: TreeCell;
  depth: number;
  slotStates: Record<string, SlotInfo>;
  onSlotClick?: (parentId: number, pos: Position) => void;
  onNodeClick?: (accountId: number) => void;
}) {
  const isMa = cell.type === 'MA';
  const circleCls = isMa
    ? `tree-node-circle ma-node ${rankClass(cell.rank)}`
    : 'tree-node-circle ca-node filled';
  const clickable = depth > 0 && !!onNodeClick;
  return (
    <li>
      <div
        className={`node-wrap ${isMa ? 'ma-node' : 'ca-node filled'}`}
        onClick={clickable ? () => onNodeClick!(cell.id) : undefined}
        style={clickable ? { cursor: 'pointer' } : undefined}
        title={clickable ? 'Click to drill-down and view network' : undefined}
      >
        <div className="node-lbl-top" style={{ marginBottom: 8 }}>
          <NodeLabel cell={cell} />
          <strong style={{ fontSize: 13, color: '#000', display: 'block' }}>{cell.name}</strong>
          <span style={{ fontSize: 11, color: '#374151' }}>
            @{cell.username}
            {cell.slot ? ` · ${cell.slot}` : ''}
          </span>
          <span style={{ fontSize: 10, color: '#6b7280', display: 'block' }}>
            L{cell.points.L} · C{cell.points.C} · R{cell.points.R} · ⬇ {cell.downline}
          </span>
        </div>
        <div className={circleCls}>
          <UserGlyph />
        </div>
      </div>
      {depth < 2 && (
        <ul>
          {POSITIONS.map((pos) => {
            const child = cell.children[pos];
            return child ? (
              <CellNode
                key={`${cell.id}-${pos}`}
                cell={child}
                depth={depth + 1}
                slotStates={slotStates}
                onSlotClick={onSlotClick}
                onNodeClick={onNodeClick}
              />
            ) : (
              <SlotNode
                key={`${cell.id}-${pos}`}
                parentId={cell.id}
                pos={pos}
                info={slotStates[`${cell.id}:${pos}`]}
                onSlotClick={onSlotClick}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

export default function TreeView({
  root,
  slotStates,
  onSlotClick,
  onNodeClick,
}: {
  root: TreeCell;
  slotStates: Record<string, SlotInfo>;
  onSlotClick?: (parentId: number, pos: Position) => void;
  onNodeClick?: (accountId: number) => void;
}) {
  return (
    <div className="mlm-tree-container">
      <ul>
        <CellNode cell={root} depth={0} slotStates={slotStates} onSlotClick={onSlotClick} onNodeClick={onNodeClick} />
      </ul>
    </div>
  );
}

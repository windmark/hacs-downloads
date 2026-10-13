import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type TipRow = { label: ReactNode; value: ReactNode; color?: string; striped?: boolean; strong?: boolean };
export type TipContent = { title: ReactNode; subtitle?: ReactNode; rows?: TipRow[]; note?: ReactNode };
type Anchor = { x: number; top: number; bottom: number };
type TooltipApi = { show: (anchor: Anchor, content: TipContent) => void; hide: () => void };

const TooltipContext = createContext<TooltipApi>({ show: () => undefined, hide: () => undefined });
const GAP = 10;
const MARGIN = 8;

/** Anchors on the element's `[data-tip-anchor]` child (the visible bar) when it has one. */
function anchorOf(element: Element): Anchor {
  const target = element.querySelector('[data-tip-anchor]') ?? element;
  const rect = target.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom };
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<{ anchor: Anchor; content: TipContent } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const show = useCallback((anchor: Anchor, content: TipContent) => setTip({ anchor, content }), []);
  const hide = useCallback(() => setTip(null), []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setPosition(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const left = Math.min(Math.max(tip.anchor.x - width / 2, MARGIN), window.innerWidth - width - MARGIN);
    const below = tip.anchor.top - height - GAP < MARGIN;
    setPosition({ left, top: below ? tip.anchor.bottom + GAP : tip.anchor.top - height - GAP, below });
  }, [tip]);

  useEffect(() => {
    if (!tip) return undefined;
    const close = () => setTip(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [tip]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);
  return (
    <TooltipContext.Provider value={api}>
      {children}
      {tip && createPortal(
        <div
          className={`chart-tip${position?.below ? ' is-below' : ''}`}
          ref={ref}
          role="tooltip"
          style={position ? { left: position.left, top: position.top } : { left: -9999, top: 0, visibility: 'hidden' }}
        >
          <strong className="chart-tip-title">{tip.content.title}</strong>
          {tip.content.subtitle && <span className="chart-tip-subtitle">{tip.content.subtitle}</span>}
          {tip.content.rows && tip.content.rows.length > 0 && (
            <dl className="chart-tip-rows">
              {tip.content.rows.map((row, index) => (
                <div className={row.strong ? 'is-strong' : ''} key={index}>
                  <dt>
                    {(row.color || row.striped) && <i className={row.striped ? 'is-striped' : ''} style={row.striped ? undefined : { background: row.color }} />}
                    {row.label}
                  </dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {tip.content.note && <span className="chart-tip-note">{tip.content.note}</span>}
        </div>,
        document.body,
      )}
    </TooltipContext.Provider>
  );
}

export function useTooltip() {
  const { show, hide } = useContext(TooltipContext);
  /** Spread onto any element to show `content` on hover, tap and keyboard focus. */
  const bind = useCallback((content: TipContent | (() => TipContent)) => {
    const open = (event: MouseEvent<Element> | FocusEvent<Element>) => {
      show(anchorOf(event.currentTarget), typeof content === 'function' ? content() : content);
    };
    return { onMouseEnter: open, onMouseLeave: hide, onFocus: open, onBlur: hide };
  }, [show, hide]);
  /** Shows a tooltip at a viewport point, for charts that track the pointer. */
  const showAt = useCallback((x: number, y: number, content: TipContent) => {
    show({ x, top: y - 6, bottom: y + 6 }, content);
  }, [show]);
  return { bind, showAt, hide };
}

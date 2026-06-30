/**
 * Dropdown — a single reusable, accessible, theme-aware select replacement.
 *
 * The owner rejected native <select> ("太丑了 · 体验割裂"): native controls render
 * with OS chrome that ignores the console's token theme and breaks the visual
 * language. This component is a fully styled listbox that flips with the theme
 * (tokens only) and supports keyboard navigation:
 *
 *   - Enter / Space / ArrowDown / ArrowUp open the menu (and move the active row)
 *   - ArrowUp / ArrowDown move the highlight; Home / End jump to ends
 *   - Enter / Space commit the highlighted option; Escape closes without change
 *   - click-outside closes; focus returns to the trigger on close
 *   - type-ahead: typing characters jumps to the next matching label
 *
 * It mirrors the ARIA listbox pattern (button[aria-haspopup=listbox] +
 * ul[role=listbox] > li[role=option]) so it is announced like a real combobox.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  /** What the user reads. Falls back to `value` when omitted. */
  label?: string;
  disabled?: boolean;
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled,
  className,
  placeholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reactId = useId();
  const listId = `${id ?? reactId}-list`;
  const typeahead = useRef<{ buf: string; at: number }>({ buf: "", at: 0 });

  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value],
  );
  const current = options.find((o) => o.value === value);
  const label = current?.label ?? current?.value ?? placeholder ?? "";

  // Open at the current selection so the highlight starts where the eye expects.
  const openMenu = useCallback(() => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  }, [disabled, selectedIndex]);

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) {
      rootRef.current?.querySelector<HTMLButtonElement>(".dd-trigger")?.focus();
    }
  }, []);

  const commit = useCallback(
    (i: number) => {
      const opt = options[i];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      close();
    },
    [options, onChange, close],
  );

  // Click-outside / focus-loss closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Keep the active row scrolled into view as it moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const moveActive = useCallback(
    (dir: 1 | -1) => {
      setActive((prev) => {
        const n = options.length;
        let i = prev;
        for (let step = 0; step < n; step++) {
          i = (i + dir + n) % n;
          if (!options[i]?.disabled) return i;
        }
        return prev;
      });
    },
    [options],
  );

  const onTypeahead = useCallback(
    (ch: string) => {
      const now = Date.now();
      const ta = typeahead.current;
      ta.buf = now - ta.at > 600 ? ch : ta.buf + ch;
      ta.at = now;
      const q = ta.buf.toLowerCase();
      const start = active + (ta.buf.length === 1 ? 1 : 0);
      for (let k = 0; k < options.length; k++) {
        const i = (start + k) % options.length;
        const text = (options[i]?.label ?? options[i]?.value ?? "").toLowerCase();
        if (!options[i]?.disabled && text.startsWith(q)) {
          setActive(i);
          return;
        }
      }
    },
    [active, options],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          onTypeahead(e.key);
        }
    }
  };

  return (
    <div ref={rootRef} className={`dd ${className ?? ""}`} data-open={open || undefined}>
      <button
        type="button"
        id={id}
        className="dd-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="dd-value" data-placeholder={!current || undefined}>
          {label || placeholder}
        </span>
        <svg className="dd-caret" width="12" height="12" viewBox="0 0 24 24" aria-hidden>
          <path
            d="m6 9 6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul
          ref={listRef}
          className="dd-menu"
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          tabIndex={-1}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className="dd-option"
              data-active={i === active || undefined}
              data-selected={o.value === value || undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so it fires before the outside-close handler.
                e.preventDefault();
                commit(i);
              }}
            >
              <span className="dd-option-label">{o.label ?? o.value}</span>
              {o.value === value && (
                <svg className="dd-check" width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="m4 12 5 5L20 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

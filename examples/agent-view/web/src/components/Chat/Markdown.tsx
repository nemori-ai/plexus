/**
 * Markdown.tsx — a tiny, dependency-free markdown renderer for assistant turns.
 * Handles the subset the agent emits: headings, **bold**, `inline code`, links,
 * ordered/unordered lists, and paragraphs. Kept minimal on purpose (no vendored
 * parser) — assistant text is trusted server output, but we still build via React
 * elements (never dangerouslySetInnerHTML) so nothing is injected as raw HTML.
 */

import { Fragment, type ReactNode } from 'react';

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // tokens: **bold**, `code`, [label](url)
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
    if (m[2] !== undefined) out.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
    else if (m[4] !== undefined) out.push(<code key={`${keyBase}-c${i}`}>{m[4]}</code>);
    else if (m[6] !== undefined)
      out.push(
        <a key={`${keyBase}-a${i}`} href={m[7]} target="_blank" rel="noreferrer noopener">
          {m[6]}
        </a>,
      );
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-tail`}>{text.slice(last)}</Fragment>);
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (para.length) {
      const key = `p${k++}`;
      blocks.push(<p key={key}>{renderInline(para.join(' '), key)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `l${k++}`;
      const items = list.items.map((it, idx) => <li key={`${key}-${idx}`}>{renderInline(it, `${key}-${idx}`)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const key = `h${k++}`;
      const Tag = (`h${h[1].length}` as 'h1' | 'h2' | 'h3');
      blocks.push(<Tag key={key}>{renderInline(h[2], key)}</Tag>);
    } else if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
    } else if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="md text-[13px] text-[var(--ink-dim)]">{blocks}</div>;
}

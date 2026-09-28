import type { ReactNode } from 'react';

// Small, safe Markdown subset for agent reports: builds React elements, never injects HTML.

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={m.index} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[12px]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else out.push(<span key={m.index} className="text-accent">{t.slice(1, t.indexOf(']'))}</span>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length} className={list.ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
        {list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
      </Tag>,
    );
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      blocks.push(<pre key={blocks.length} className="overflow-auto rounded-lg bg-surface-3 p-3 font-mono text-[12px]">{code.join('\n')}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(<h4 key={blocks.length} className="mt-3 text-[13px] font-semibold text-fg first:mt-0">{inline(h[2])}</h4>);
    } else if (li) {
      const ordered = !!li[2];
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(li[3]);
    } else if (line.trim()) {
      flush();
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    } else flush();
  }
  flush();
  return <div className="space-y-2 text-[13px] leading-relaxed" data-selectable>{blocks}</div>;
}

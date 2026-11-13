export interface SplitTicket {
  label: string;
  text: string;
}

export interface SplitTicketsResult {
  tickets: SplitTicket[];
  warnings: string[];
}

export interface SplitTicketsOptions {
  maxTickets?: number;
  maxCharsPerTicket?: number;
  maxTotalChars?: number;
}

const SEPARATOR = /^\s*(?:[-=*_~]{3,}|#{3,})\s*$/;
const HEADING = /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:ticket|issue|alert|finding|advisory)\s*(?:#|no\.?|nr\.?)?\s*([A-Za-z0-9._-]+)?\s*(?:\*\*)?\s*[:.)-]?\s*(?:\*\*)?\s*$/i;
const LABELED_SEPARATOR = /^\s*[-=*_~]{3,}\s*(.+?)\s*[-=*_~]{3,}\s*$/;

export function splitTickets(text: string, options: SplitTicketsOptions = {}): SplitTicketsResult {
  const maxTickets = options.maxTickets ?? 20;
  const maxChars = options.maxCharsPerTicket ?? 20_000;
  const maxTotal = options.maxTotalChars ?? 200_000;
  const warnings: string[] = [];

  let input = text.replace(/\r\n?/g, '\n');
  if (input.length > maxTotal) {
    input = input.slice(0, maxTotal);
    warnings.push('The pasted text is very long, so only the first part was read.');
  }

  const blocks: Array<{ label?: string; lines: string[] }> = [{ lines: [] }];
  const start = (label?: string): void => {
    const current = blocks[blocks.length - 1] as { label?: string; lines: string[] };
    if (current.lines.join('').trim() === '' && current.label === undefined) {
      if (label !== undefined) current.label = label;
      return;
    }
    blocks.push(label === undefined ? { lines: [] } : { label, lines: [] });
  };

  for (const line of input.split('\n')) {
    const labeled = LABELED_SEPARATOR.exec(line);
    if (labeled && !/^[-=*_~]+$/.test(labeled[1] as string)) {
      start((labeled[1] as string).replace(/\s+/g, ' ').slice(0, 60));
      continue;
    }
    if (SEPARATOR.test(line)) {
      start();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const id = heading[1];
      start(id ? `Ticket ${id}` : undefined);
      continue;
    }
    (blocks[blocks.length - 1] as { lines: string[] }).lines.push(line);
  }

  const tickets: SplitTicket[] = [];
  for (const block of blocks) {
    let body = block.lines.join('\n').trim();
    if (body === '') continue;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      warnings.push(`${block.label ?? `Ticket ${tickets.length + 1}`} is very long, so only the first ${maxChars} characters were read.`);
    }
    tickets.push({ label: block.label ?? `Ticket ${tickets.length + 1}`, text: body });
  }

  if (tickets.length > maxTickets) {
    warnings.push(`Only the first ${maxTickets} tickets were read (${tickets.length} were pasted).`);
    tickets.length = maxTickets;
  }

  const seen = new Map<string, number>();
  for (const ticket of tickets) {
    const count = (seen.get(ticket.label) ?? 0) + 1;
    seen.set(ticket.label, count);
    if (count > 1) ticket.label = `${ticket.label} (${count})`;
  }
  return { tickets, warnings };
}

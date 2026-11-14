export type DiscordReference =
  | { readonly kind: "user"; readonly id: string; readonly label: string }
  | { readonly kind: "message"; readonly id: string; readonly channel: string; readonly guild: string; readonly label: string };

export const escapeText = (value: string) => value.replace(/[\\`*_~|[\]()]/g, "\\$&");
export const escapeLabel = (value: string) => escapeText(value).replace(/[<>]/g, "\\$&");
/** The wishlist tab keeps Discord from unfurling a profile embed for the link. */
const userUrl = (user: string) => `https://discord.com/users/${user}?tab=wishlist`;
export const messageUrl = (guild: string, channel: string, message: string) =>
  `https://discord.com/channels/${guild}/${channel}/${message}`;

export function referenceLink(reference: DiscordReference): string {
  const label = escapeLabel(reference.label.replace(/[\r\n]/g, " ").slice(0, 80));
  return reference.kind === "user" ? `**[${label}](<${userUrl(reference.id)}>)**` :
    `[${label}](<${messageUrl(reference.guild, reference.channel, reference.id)}>)`;
}

/** Only prose URLs are relabeled; existing Markdown links and code retain their contents. */
export function githubReferences(value: string, escapePlain = false): string {
  const tokens = /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^[ \t]*>>>[\s\S]*$|^[ \t]*>[^\n]*(?:\n|$)|\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)|<?https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*(?![\w-])(?:[/?#][^\s<>)]+)?>?/gim;
  const plain = (text: string) => escapePlain ? escapeText(text) : text;
  let out = "", offset = 0;
  for (const match of value.matchAll(tokens)) {
    out += plain(value.slice(offset, match.index));
    const token = match[0], url = token.replace(/^<|>$/g, "");
    const github = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/([1-9]\d*)/i.exec(url);
    if (github && url.length <= 500) {
      const suffix = /[.,!?;:]+$/.exec(url)?.[0] ?? "";
      const destination = suffix ? url.slice(0, -suffix.length) : url;
      out += `[${github[1]?.toLowerCase() === "pull" ? "PR" : "Issue"} #${github[2]}](<${destination}>)${plain(suffix)}`;
    } else out += plain(token);
    offset = match.index + token.length;
  }
  return out + plain(value.slice(offset));
}

export interface KnownPerson { readonly id: string; readonly label: string; readonly present: boolean }

const LOWERCASE_WORD = /^\p{Ll}+$/u;
const CAPITALIZED_WORD = /^\p{Lu}\p{Ll}+$/u;
const STRUCTURE = /```[\s\S]*?(?:```|(?![\s\S]))|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|^[ \t]*>>>[\s\S]*$|^[ \t]*>[^\n]*(?:\n|$)|\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)|<[^<>\s]*>|https?:\/\/\S+/gim;
const QUOTATION = /"[^"]*"|\u201c[^\u201d]*\u201d/g;
/** Code, block quotes, links, mentions and URLs first; then quotations, ignoring quote marks inside those. */
function protectedRanges(value: string): [number, number][] {
  const ranges = [...value.matchAll(STRUCTURE)].map((match): [number, number] => [match.index, match.index + match[0].length]);
  const masked = ranges.reduce((text, [start, end]) => text.slice(0, start) + "\u0000".repeat(end - start) + text.slice(end), value);
  ranges.push(...[...masked.matchAll(QUOTATION)].map((match): [number, number] => [match.index, match.index + match[0].length]));
  return ranges.sort((a, b) => a[0] - b[0]);
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentenceStart = (before: string) => {
  const head = before.replace(/[\s*_"'\u201c\u2018(\-\u2013\u2014\u2022#>]+$/u, "");
  return head === "" || /[.!?:]$/.test(head) || before.slice(head.length).includes("\n");
};

/**
 * Links prose names that belong to exactly one known person; code, block and inline quotes, links, mentions and URLs
 * stay intact.
 * The longest known name wins, so a name shared by several people stays plain as a whole. Lowercase single words
 * are never linked, and a capitalized single word only mid-sentence (a proper noun) unless that person is present
 * in the turn. `fits` judges the final outgoing message; links that would break it are left as plain names.
 */
export function personReferences(value: string, people: readonly KnownPerson[],
  fits: (text: string) => boolean = text => text.length <= 2000): string {
  const byLabel = new Map<string, { ids: Set<string>; present: boolean }>();
  for (const person of people) {
    if ([...person.label].length < 3 || LOWERCASE_WORD.test(person.label)) continue;
    const known = byLabel.get(person.label) ?? { ids: new Set<string>(), present: false };
    known.ids.add(person.id);
    known.present ||= person.present;
    byLabel.set(person.label, known);
  }
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  if (!labels.length || !fits(value)) return value;
  const names = new RegExp(`(?<![\\p{L}\\p{N}_])(\\*\\*)?(${labels.map(escapeRegExp).join("|")})(\\*\\*)?(?![\\p{L}\\p{N}_])`, "gu");
  const edits: { start: number; end: number; text: string }[] = [];
  const scan = (start: number, end: number) => {
    for (const match of value.slice(start, end).matchAll(names)) {
      const open = match[1] ?? "", label = match[2] ?? "", close = match[3] ?? "", known = byLabel.get(label);
      const [id, ...others] = known ? [...known.ids] : [];
      if (!known || !id || others.length) continue;
      const at = start + match.index + open.length;
      if (CAPITALIZED_WORD.test(label) && !known.present && sentenceStart(value.slice(0, at))) continue;
      const bold = open !== "" && close !== "";
      edits.push({ start: bold ? at - open.length : at, end: at + label.length + (bold ? close.length : 0),
        text: referenceLink({ kind: "user", id, label }) });
    }
  };
  let offset = 0;
  for (const [start, end] of protectedRanges(value)) {
    if (start > offset) scan(offset, start);
    offset = Math.max(offset, end);
  }
  scan(offset, value.length);
  const linked = (count: number) => {
    let out = "", position = 0;
    for (const edit of edits.slice(0, count)) {
      out += value.slice(position, edit.start) + edit.text;
      position = edit.end;
    }
    return out + value.slice(position);
  };
  for (let count = edits.length; count > 0; count--) {
    const out = linked(count);
    if (fits(out)) return out;
  }
  return value;
}

/** Generated Discord links are indivisible; clipping must never leave a partial destination. */
export function clipReferences(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const end = Math.max(0, maximum - 3);
  const links = /(?:\*\*)?\[(?:\\.|[^\]\\])*\]\(<https:\/\/(?:discord(?:app)?\.com\/(?:users\/\d+(?:\?tab=wishlist)?|channels\/(?:@me|\d+)\/\d+\/\d+)|github\.com\/[^>\s]+)>\)(?:\*\*)?/g;
  for (const match of value.matchAll(links)) {
    if (match.index < end && match.index + match[0].length > end) {
      return `${value.slice(0, match.index).trimEnd()}...`;
    }
  }
  return `${value.slice(0, end).replace(/[\uD800-\uDBFF\\]$/, "")}...`;
}

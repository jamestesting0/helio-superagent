export type DiscordReference =
  | { readonly kind: "user"; readonly id: string; readonly label: string }
  | { readonly kind: "message"; readonly id: string; readonly channel: string; readonly guild: string; readonly label: string };

export const escapeText = (value: string) => value.replace(/[\\`*_~|[\]()]/g, "\\$&");
export const escapeLabel = (value: string) => escapeText(value).replace(/[<>]/g, "\\$&");
export const messageUrl = (guild: string, channel: string, message: string) =>
  `https://discord.com/channels/${guild}/${channel}/${message}`;

export function referenceLink(reference: DiscordReference): string {
  const label = escapeLabel(reference.label.replace(/[\r\n]/g, " ").slice(0, 80));
  return reference.kind === "user" ? `**[${label}](<https://discord.com/users/${reference.id}>)**` :
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

/** Generated Discord links are indivisible; clipping must never leave a partial destination. */
export function clipReferences(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const end = Math.max(0, maximum - 3);
  const links = /(?:\*\*)?\[(?:\\.|[^\]\\])*\]\(<https:\/\/(?:discord(?:app)?\.com\/(?:users\/\d+|channels\/(?:@me|\d+)\/\d+\/\d+)|github\.com\/[^>\s]+)>\)(?:\*\*)?/g;
  for (const match of value.matchAll(links)) {
    if (match.index < end && match.index + match[0].length > end) {
      return `${value.slice(0, match.index).trimEnd()}...`;
    }
  }
  return `${value.slice(0, end).replace(/[\uD800-\uDBFF\\]$/, "")}...`;
}

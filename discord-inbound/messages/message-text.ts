import { omitLinks } from "./images.ts";

export interface Embed {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly author?: { readonly name?: string };
  readonly fields?: readonly { readonly name: string; readonly value: string }[];
  readonly footer?: { readonly text?: string };
  readonly image?: { readonly url?: string };
  readonly thumbnail?: { readonly url?: string };
}

export interface Component {
  readonly type: number;
  readonly content?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly label?: string }[];
  readonly components?: readonly Component[];
  readonly accessory?: Component;
}

export interface MentionedUser {
  readonly id: string;
  readonly username?: string;
  readonly global_name?: string | null;
}

const MAX_COMPONENT_CHARS = 4000;

// Link previews only restate links Helio may not open, so only bot-built ("rich") embeds are read.
const readable = (embed: Embed) => embed.type === undefined || embed.type === "rich";

// Bot text is full of `[label](<url>)` markdown: keep the label, plus the reference when the link may be kept.
function plainLinks(text: string): string {
  return omitLinks(text.replace(/\[([^\]\n]+)\]\(<?([^)\s>]+)>?\)/g, (_, label: string, url: string) => {
    const kept = omitLinks(url);
    return kept === "[link omitted]" ? label : `${label} (${kept})`;
  }));
}

export function embedText(embeds: readonly Embed[] | undefined): string[] {
  return (embeds ?? []).filter(readable).flatMap((embed) => [
    embed.author?.name, embed.title, embed.description,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    embed.footer?.text,
    embed.image?.url || embed.thumbnail?.url ? "[embed image]" : undefined,
  ]).filter((text): text is string => typeof text === "string" && text.length > 0).map(plainLinks);
}

export function embedImageUrls(embeds: readonly Embed[] | undefined): string[] {
  return (embeds ?? []).filter(readable).flatMap((embed) => [embed.image?.url, embed.thumbnail?.url])
    .filter((url): url is string => typeof url === "string");
}

export function componentText(components: readonly Component[] | undefined): string[] {
  const out: string[] = [];
  const walk = (list: readonly Component[] | undefined) => {
    for (const component of list ?? []) {
      switch (component.type) {
        case 10: if (component.content) out.push(component.content); break;
        case 2: if (component.label) out.push(`[button: ${component.label}]`); break;
        case 3: {
          const labels = [component.placeholder, ...(component.options ?? []).map((option) => option.label)];
          out.push(`[select: ${labels.filter(Boolean).join(" | ")}]`);
          break;
        }
        case 5: case 6: case 7: case 8:
          out.push(component.placeholder ? `[select: ${component.placeholder}]` : "[select]");
          break;
        case 11: case 12: out.push("[image]"); break;
        case 13: out.push("[file]"); break;
      }
      walk(component.components);
      if (component.accessory) walk([component.accessory]);
    }
  };
  walk(components);
  const capped: string[] = [];
  let used = 0;
  for (const text of out.map(plainLinks)) {
    if (used >= MAX_COMPONENT_CHARS) break;
    capped.push(text.slice(0, MAX_COMPONENT_CHARS - used));
    used += text.length;
  }
  return capped;
}

// Names travel beside the text: the text itself must stay byte-exact (approvals compare it to the live message).
export function mentionedUsers(mentions: readonly MentionedUser[] | undefined): Record<string, string> | undefined {
  const named = (mentions ?? []).filter((user) => /^[0-9]+$/.test(user.id) && (user.global_name || user.username));
  return named.length ? Object.fromEntries(named.map((user) => [user.id, String(user.global_name || user.username).slice(0, 100)])) : undefined;
}

import { omitLinks, prepareAttachments, type Attachment } from "./images.ts";
import { componentText, embedImageUrls, embedText, mentionedUsers, type Component, type Embed, type MentionedUser } from "./message-text.ts";

interface Snapshot {
  readonly content?: string;
  readonly timestamp?: string;
  readonly attachments?: readonly Attachment[];
  readonly embeds?: readonly Embed[];
  readonly components?: readonly Component[];
}

export interface MessageBody {
  readonly id: string;
  readonly content: string;
  readonly attachments?: readonly Attachment[];
  readonly embeds?: readonly Embed[];
  readonly components?: readonly Component[];
  readonly mentions?: readonly MentionedUser[];
  readonly message_reference?: {
    readonly type?: number;
    readonly message_id?: string;
    readonly channel_id?: string;
    readonly guild_id?: string;
  };
  readonly message_snapshots?: readonly { readonly message: Snapshot }[];
}

const DISCORD_FILE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[0-9]+\/[0-9]+\/([^/?#\\]+)(?:\?[^#\\]*)?$/;

// Only images Discord itself hosts are downloaded, through the same checks as attachments; others stay a text note.
function embedImages(embeds: readonly Embed[] | undefined): Attachment[] {
  return embedImageUrls(embeds).flatMap((url) => {
    const name = DISCORD_FILE.exec(url)?.[1];
    if (!name) return [];
    try { return [{ url, filename: decodeURIComponent(name) }]; }
    catch (error) {
      if (!(error instanceof URIError)) throw error;
      return [];
    }
  });
}

function readable(message: Snapshot) {
  const embeds = embedText(message.embeds);
  const components = componentText(message.components);
  return { ...(embeds.length ? { embed_text: embeds } : {}), ...(components.length ? { component_text: components } : {}) };
}

export async function prepareMessageBody(message: MessageBody, attachmentRoot: string, includeEmbeds = false) {
  const prepared = await prepareAttachments([...(message.attachments ?? []), ...embedImages(message.embeds)], message.id, attachmentRoot);
  const snapshots = message.message_reference?.type === 1 ? message.message_snapshots ?? [] : [];
  const forwarded = [];
  for (const { message: snapshot } of snapshots) {
    const files = await prepareAttachments([...(snapshot.attachments ?? []), ...embedImages(snapshot.embeds)], message.id, attachmentRoot);
    const components = componentText(snapshot.components);
    forwarded.push({
      content: omitLinks(snapshot.content ?? ""),
      embed_text: embedText(snapshot.embeds),
      ...(components.length ? { component_text: components } : {}),
      sent_at: snapshot.timestamp,
      source: {
        message_id: message.message_reference?.message_id,
        channel_id: message.message_reference?.channel_id,
        guild_id: message.message_reference?.guild_id,
      },
      attachments: files.files,
      blocked_attachments: files.blocked,
    });
  }
  const names = mentionedUsers(message.mentions);
  return {
    content: omitLinks(message.content),
    ...(includeEmbeds ? { embed_text: embedText(message.embeds) } : {}),
    ...readable(message),
    ...(names ? { mentioned_users: names } : {}),
    attachments: prepared.files,
    blocked_attachments: prepared.blocked,
    forwarded,
    forwarded_unavailable: message.message_reference?.type === 1 && snapshots.length === 0,
  };
}

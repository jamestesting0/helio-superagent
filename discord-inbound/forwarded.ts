import { omitLinks, prepareAttachments, type Attachment } from "./images.ts";

interface Snapshot {
  readonly content?: string;
  readonly timestamp?: string;
  readonly attachments?: readonly Attachment[];
  readonly embeds?: readonly {
    readonly title?: string;
    readonly description?: string;
    readonly fields?: readonly { readonly name: string; readonly value: string }[];
    readonly footer?: { readonly text: string };
  }[];
}

export interface MessageBody {
  readonly id: string;
  readonly content: string;
  readonly attachments?: readonly Attachment[];
  readonly embeds?: Snapshot["embeds"];
  readonly message_reference?: {
    readonly type?: number;
    readonly message_id?: string;
    readonly channel_id?: string;
    readonly guild_id?: string;
  };
  readonly message_snapshots?: readonly { readonly message: Snapshot }[];
}

function embedText(embeds: Snapshot["embeds"]) {
  return (embeds ?? []).flatMap((embed) => [
    embed.title, embed.description,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    embed.footer?.text,
  ]).filter((text): text is string => typeof text === "string").map(omitLinks);
}

export async function prepareMessageBody(message: MessageBody, attachmentRoot: string, includeEmbeds = false) {
  const prepared = await prepareAttachments(message.attachments ?? [], message.id, attachmentRoot);
  const snapshots = message.message_reference?.type === 1 ? message.message_snapshots ?? [] : [];
  const forwarded = [];
  for (const { message: snapshot } of snapshots) {
    const files = await prepareAttachments(snapshot.attachments ?? [], message.id, attachmentRoot);
    forwarded.push({
      content: omitLinks(snapshot.content ?? ""),
      embed_text: embedText(snapshot.embeds),
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
  return {
    content: omitLinks(message.content),
    ...(includeEmbeds ? { embed_text: embedText(message.embeds) } : {}),
    attachments: prepared.files,
    blocked_attachments: prepared.blocked,
    forwarded,
    forwarded_unavailable: message.message_reference?.type === 1 && snapshots.length === 0,
  };
}

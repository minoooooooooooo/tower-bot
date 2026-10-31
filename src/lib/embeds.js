import { EmbedBuilder } from 'discord.js';

export const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  muted: 0x99aab5,
};

export function embed({
  title,
  description,
  color = COLORS.primary,
  fields,
  footer,
  thumbnail,
  image,
  author,
  url,
  timestamp = true,
} = {}) {
  const builder = new EmbedBuilder().setColor(color);

  if (title) builder.setTitle(title);
  if (description) builder.setDescription(description);
  if (url) builder.setURL(url);
  if (fields?.length) builder.addFields(fields);
  if (footer) builder.setFooter({ text: footer });
  if (thumbnail) builder.setThumbnail(thumbnail);
  if (image) builder.setImage(image);
  if (author) builder.setAuthor(author);
  if (timestamp) builder.setTimestamp(new Date());

  return builder;
}

export const successEmbed = (title, description) =>
  embed({ title, description, color: COLORS.success });

export const errorEmbed = (title, description) =>
  embed({ title, description, color: COLORS.danger });

export const warningEmbed = (title, description) =>
  embed({ title, description, color: COLORS.warning });

export const infoEmbed = (title, description) =>
  embed({ title, description, color: COLORS.primary });

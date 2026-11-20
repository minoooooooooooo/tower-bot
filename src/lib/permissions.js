import { PermissionsBitField } from 'discord.js';

/**
 * Arabic names for the permissions the bot actually checks or denies. Anything
 * missing falls back to the Discord name, so a new permission is readable
 * rather than blank.
 */
const NAMES = {
  Administrator: 'مسؤول',
  ViewChannel: 'عرض القنوات',
  ManageChannels: 'إدارة القنوات',
  ManageRoles: 'إدارة الرتب',
  ManageMessages: 'إدارة الرسائل',
  ManageNicknames: 'إدارة الأسماء',
  ManageGuild: 'إدارة السيرفر',
  ManageEmojisAndStickers: 'إدارة الإيموجيات',
  ManageGuildExpressions: 'إدارة الإيموجيات',
  ManageWebhooks: 'إدارة الويب هوك',
  KickMembers: 'طرد الأعضاء',
  BanMembers: 'حظر الأعضاء',
  ModerateMembers: 'كتم الأعضاء',
  SendMessages: 'إرسال الرسائل',
  SendMessagesInThreads: 'إرسال الرسائل في المواضيع',
  AddReactions: 'إضافة التفاعلات',
  ReadMessageHistory: 'قراءة سجل الرسائل',
  AttachFiles: 'إرفاق الملفات',
  EmbedLinks: 'إرفاق الروابط',
  UseExternalEmojis: 'استخدام إيموجيات خارجية',
  CreatePublicThreads: 'إنشاء مواضيع عامة',
  CreatePrivateThreads: 'إنشاء مواضيع خاصة',
  Connect: 'الاتصال بالصوت',
  Speak: 'التحدث',
  Stream: 'البث',
};

/** Arabic name for a flag name ('ManageMessages') or a flag value. */
export function permissionName(value) {
  const key =
    typeof value === 'string'
      ? value
      : Object.keys(PermissionsBitField.Flags).find(
          (name) => PermissionsBitField.Flags[name] === value,
        );

  if (key && NAMES[key]) return NAMES[key];

  return key ? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2') : String(value);
}

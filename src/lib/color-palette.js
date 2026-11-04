import { embed } from './embeds.js';

/**
 * The palette shown by `/colors`. The color test parses every entry through
 * `parseColor`, so this list can never drift from what the parser accepts.
 */
export const COLOR_GROUPS = [
  {
    name: 'الألوان الأساسية',
    colors: [
      ['أحمر', 'red', 0xff0000],
      ['برتقالي', 'orange', 0xffa500],
      ['أصفر', 'yellow', 0xffff00],
      ['أخضر', 'green', 0x008000],
      ['أزرق', 'blue', 0x0000ff],
      ['بنفسجي', 'purple', 0x800080],
      ['أسود', 'black', 0x000001],
      ['أبيض', 'white', 0xffffff],
    ],
  },
  {
    name: 'ألوان فرعية',
    colors: [
      ['قرمزي', 'crimson', 0xdc143c],
      ['عنبري', 'amber', 0xffbf00],
      ['ذهبي', 'gold', 0xffd700],
      ['ليموني', 'lime', 0x00ff00],
      ['زمردي', 'emerald', 0x50c878],
      ['نعناعي', 'mint', 0x98ff98],
      ['تركوازي', 'teal', 0x008080],
      ['سماوي', 'sky', 0x87ceeb],
    ],
  },
  {
    name: 'أزرق وبنفسجي',
    colors: [
      ['كحلي', 'navy', 0x000080],
      ['نيلي', 'indigo', 0x4b0082],
      ['أرجواني', 'purple', 0x800080],
      ['فوشيا', 'fuchsia', 0xff00ff],
      ['وردي', 'pink', 0xffc0cb],
      ['زهري', 'rose', 0xff007f],
    ],
  },
  {
    name: 'ألوان هادئة',
    colors: [
      ['بني', 'brown', 0xa52a2a],
      ['عنابي', 'maroon', 0x800000],
      ['زيتوني', 'olive', 0x808000],
      ['فضي', 'silver', 0xc0c0c0],
      ['رمادي', 'gray', 0x808080],
      ['ديسكورد', 'blurple', 0x5865f2],
    ],
  },
];

function hexOf(value) {
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

function colorLine([ar, en, hex]) {
  return `**${ar}** · ${en} · \`${hexOf(hex)}\``;
}

export function colorListEmbed() {
  return embed({
    title: 'قائمة الألوان',
    description: [
      'اكتب اسم اللون بالعربية أو الإنجليزية، أو استخدم كود الهيكس.',
      '`:-color أحمر أزرق`  ·  `/color primary:أحمر secondary:أزرق`',
      'لإزالة لون الدور: `clear` أو `مسح`.',
      'الأسود يُحفظ كـ `#000001` لأن Discord يحجز `#000000` لعدم وجود لون.',
    ].join('\n'),
    fields: COLOR_GROUPS.map((group) => ({
      name: group.name,
      value: group.colors.map(colorLine).join('\n'),
      inline: false,
    })),
    footer: 'الأسماء الإنجليزية مقبولة أيضًا',
  });
}

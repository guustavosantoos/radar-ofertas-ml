export interface MessageTemplate {
  id: string;
  name: string;
  template: string;
}

export const DEFAULT_WHATSAPP_TEMPLATE: MessageTemplate = {
  id: 'default-whatsapp',
  name: 'Padrão WhatsApp Completo',
  template: `🔥 *{emoji} OPORTUNIDADE {nivel}!*

*{produto}*

❌ De: ~{precoAntigo}~
✅ *Por: {preco}* ({desconto} OFF)
💳 {parcelamento}
🚚 {frete}

🛒 *Garanta o seu aqui:*
{link}`,
};

export const ACHADINHOS_MELI_TEMPLATE: MessageTemplate = {
  id: 'achadinhos-meli',
  name: 'Estilo Achadinhos Mercado Livre',
  template: `{produto}

De ~{precoAntigo}~
Por *{preco}* 💵

🛒 Achado no Mercado Livre
👉 {link}`,
};

export const FLASH_IMPERDIVEL_TEMPLATE: MessageTemplate = {
  id: 'flash-imperdivel',
  name: 'Alerta Flash Imperdível',
  template: `⚡ *OFERTA IMPERDÍVEL DETECTADA!* (Pontuação {score}/100)

*{produto}*

🔥 *Apenas {preco}!* ({desconto} de desconto)
🚚 {frete}
⭐ {avaliacao}

👇 *Acesse o link oficial:*
{link}`,
};

export const TEMPLATES = [DEFAULT_WHATSAPP_TEMPLATE, ACHADINHOS_MELI_TEMPLATE, FLASH_IMPERDIVEL_TEMPLATE];

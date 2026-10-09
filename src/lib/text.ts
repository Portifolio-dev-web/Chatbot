/**
 * minúsculas, sem acento, só letras/números/":" separados por um espaço.
 * Usada para comparar o que a pessoa digita com palavras-chave e opções ("Endereço?" ->
 * "endereco"). Fica aqui (e não em intents.ts) porque os perfis também a usam para validar
 * as próprias palavras-chave.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();
}

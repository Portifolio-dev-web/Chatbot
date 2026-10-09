/*
 * CONTEÚDO DA CLÍNICA: tudo o que o bot informa sobre a clínica fica aqui.
 * Troque cada "PREENCHER" pelo texto real. Em produção o servidor se recusa a subir enquanto
 * houver algum "PREENCHER": é melhor o deploy falhar do que o bot mandar "PREENCHER: endereço"
 * (ou um preço errado) para um cliente.
 *
 * Formatação do WhatsApp: *negrito*, _itálico_, quebras de linha com \n.
 */
export const PLACEHOLDER = 'PREENCHER';

export const CLINIC = {
  /** Nome como o cliente conhece. */
  name: 'PREENCHER: nome da clínica',
  /**
   * Quem é o responsável pelos dados (LGPD art. 9º, III): razão social e CNPJ, ou nome e
   * registro profissional (CREFITO/CREF). Aparece no aviso de consentimento.
   */
  legalName: 'PREENCHER: razão social e CNPJ (ou nome e CREFITO/CREF)',
  address: 'PREENCHER: rua, número, bairro, cidade/UF',
  /** Link do Google Maps (opcional: deixe '' para não enviar). */
  mapsUrl: '',
  openingHours: 'PREENCHER: ex. segunda a sexta, 6h às 21h; sábado, 8h às 12h',
  /** Como falar com uma pessoa: telefone/WhatsApp da recepção e horário. */
  reception: 'PREENCHER: ex. (11) 90000-0000, de segunda a sexta, 8h às 18h',
  prices:
    'PREENCHER: valores e pacotes, ex.:\n' +
    '*Fisioterapia*\n• Avaliação: R$ 0\n• Sessão avulsa: R$ 0\n• Pacote 10 sessões: R$ 0\n\n' +
    '*Personal trainer*\n• Aula avulsa: R$ 0\n• Plano mensal (2x/semana): R$ 0',
} as const;

// Os SERVIÇOS (nome, descrição, triagem) não ficam aqui: vêm do perfil da instalação
// (CLINIC_PROFILE, src/profiles). Este arquivo guarda só os dados do negócio.

/** Campos ainda com "PREENCHER" (vazio = conteúdo pronto). */
export function unfilledContentFields(): string[] {
  return Object.entries(CLINIC)
    .filter(([, value]) => value.includes(PLACEHOLDER))
    .map(([key]) => key);
}

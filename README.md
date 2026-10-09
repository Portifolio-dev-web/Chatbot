# Chatbot de WhatsApp: Fisioterapia e Personal Trainer

Atendimento automático pela API oficial do WhatsApp (Meta Cloud API): triagem, dúvidas
frequentes (valores, endereço, horários), agendamento e cancelamento, lembretes e avisos à
recepção. Node.js · TypeScript · Express 5 · PostgreSQL 18 · Prisma 7 · Docker.

Nome e telefone dos clientes ficam **criptografados** no banco. O bot pede consentimento antes
do primeiro agendamento (LGPD, art. 11) e oferece "apagar meus dados".

## Pré-requisitos

- **Docker Desktop** (ou Docker Engine com Compose 2.24+).
- **ngrok** (conta gratuita + agente): <https://ngrok.com/download>
- **App na Meta** com WhatsApp: em <https://developers.facebook.com/apps>, crie um app com o caso
  de uso *Conectar-se com clientes pelo WhatsApp*. A Meta fornece um número de teste.
- Node.js 22.18+ só para rodar sem Docker ou rodar os testes.

## 1. Configurar o `.env`

```bash
cp .env.example .env
```

O `.env` nunca vai para o git. Gere os valores aleatórios (cada variável com o seu):

```bash
# hex: WHATSAPP_VERIFY_TOKEN e POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# base64: ENCRYPTION_KEY e BLIND_INDEX_KEY (duas chaves diferentes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Sem Node instalado, troque `node` por `docker run --rm node:24-alpine node`.

| Variável | Onde achar |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → **Configuração da API** (*API Setup*): token temporário, vale 24 h. Para uso contínuo, veja [Antes de produção](#antes-de-produção). |
| `WHATSAPP_PHONE_NUMBER_ID` | Mesma tela: **ID do número de telefone** (não é o número em si). |
| `WHATSAPP_APP_SECRET` | App → **Configurações do app → Básico → Chave secreta do aplicativo**. |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa (valor gerado acima) e cola no painel no passo 4. |
| `RECEPTION_WHATSAPP` | WhatsApp da recepção (DDI + DDD + número), **diferente** do número do bot. Opcional para testar. |
| `CLINIC_PROFILE` | Tipo de negócio: `fisio-personal`, `fisioterapia` ou `personal` (veja [Perfis](#perfis)). |

> ⚠️ Guarde `ENCRYPTION_KEY` e `BLIND_INDEX_KEY` num cofre de senhas, fora do backup do banco.
> Perder a chave = perder nome e telefone de todos os clientes.

Para testar, mantenha `NODE_ENV=development`: assim o bot sobe mesmo com os textos da clínica
ainda marcados com `PREENCHER`.

## 2. Subir com Docker

```bash
docker compose up -d --build                            # banco + app (migrações rodam sozinhas)
docker compose run --rm app node dist/scripts/seed.js   # grade de horários de EXEMPLO (uma vez)
docker compose logs -f app                              # acompanhar
```

Confira em <http://localhost:3000/health> → `{"status":"ok"}`.

A grade de exemplo é a do perfil (`src/profiles/index.ts`):
- fisioterapia: segunda a sexta, 8h–12h e 14h–18h;
- personal trainer: segunda a sexta, 6h–10h e 17h–21h; sábado, 8h–12h.

Depois do seed, a grade vive na tabela `availability_rules`.

## 3. Expor com ngrok

A Meta só chama URLs **https** públicas:

```bash
ngrok config add-authtoken SEU_TOKEN_DO_NGROK              # uma vez
ngrok http 3000 --url=https://SEU-DOMINIO.ngrok-free.app
```

Use o domínio fixo gratuito do ngrok (painel do ngrok → *Domains*): a URL não muda e o webhook
não precisa ser recadastrado. Só `ngrok http 3000` também funciona, mas gera uma URL nova a cada
execução.

## 4. Configurar o webhook na Meta

App → **WhatsApp → Configuração** (*Configuration*) → *Webhook* → **Editar**:

1. **URL de retorno**: `https://SEU-DOMINIO.ngrok-free.app/webhook`
2. **Token de verificação**: o mesmo valor de `WHATSAPP_VERIFY_TOKEN`.
3. **Verificar e salvar**. Nos logs aparece `webhook verificado pela Meta`.
4. Em **Campos do webhook**, assine **`messages`** (é o único necessário).

**Números de teste:** com o número de teste da Meta, o bot só conversa com até 5 números
cadastrados. Em **Configuração da API → Para** (*To*), adicione o seu celular e confirme o
código. Para testar os avisos, adicione também o número da recepção.

Mande **"oi"** do seu celular para o número de teste: o bot responde com o menu.

## 5. Templates (lembretes e avisos à recepção)

Mensagens que o bot **inicia**, como o lembrete e o aviso à recepção, só saem com template
aprovado. Em **Gerenciador do WhatsApp → Modelos de mensagem → Criar modelo**, crie os dois
abaixo:
- categoria **Utilidade**, idioma **Português (BR)** e tipo de variável **Número** (`{{1}}`);
- nomes e ordem das variáveis iguais aos de `src/content/templates.ts`.

**`lembrete_atendimento`**

```text
Olá, {{1}}! Passando para lembrar do seu horário de {{2}} em {{3}}. Podemos contar com você?
```

- Botões de **resposta rápida**, nesta ordem: `Confirmo` e `Preciso remarcar`.
- Exemplos para a Meta: `Maria` · `fisioterapia` · `quinta-feira, 09/10 às 08:00`.

**`aviso_agenda_recepcao`**

```text
Aviso automático da agenda do WhatsApp: {{1}}. Cliente: {{2}}. Serviço: {{3}}. Data e horário: {{4}}. Confira na sua agenda.
```

- Sem botões.
- Exemplos: `novo agendamento` · `Maria Souza` · `Fisioterapia` · `quinta-feira, 09/10 às 08:00`.

A aprovação leva de minutos a 48 h. Envios feitos antes dela falham com o código `132001` e não
são repetidos (ficam como `FAILED` na tabela `outbound_messages`): crie os templates antes de
abrir o bot para clientes.

## Antes de produção

- [ ] Preencher `src/content/clinic.ts`: nome, razão social/CNPJ, endereço, horários,
      recepção e preços. Em produção o servidor **não sobe** com `PREENCHER`.
- [ ] Publicar a política de privacidade (https) em `PRIVACY_POLICY_URL`.
- [ ] Pedir a um advogado para revisar o aviso de consentimento (`src/content/consent.ts`).
- [ ] Ajustar a grade (`availability_rules`) e cadastrar feriados (`schedule_blocks`).
- [ ] Token permanente:
  1. **Configurações do negócio → Usuários do sistema** → criar um usuário (admin);
  2. atribuir a ele o app e a conta do WhatsApp;
  3. gerar o token com `whatsapp_business_messaging` e `whatsapp_business_management`.
- [ ] Registrar o número oficial da clínica e trocar o `WHATSAPP_PHONE_NUMBER_ID`.
- [ ] `NODE_ENV=production` e `RECEPTION_WHATSAPP` preenchido.
- [ ] HTTPS de verdade no lugar do ngrok.
- [ ] Backup do banco **e**, em outro lugar, das chaves.

## Perfis

Cada instalação atende um tipo de negócio, escolhido em `CLINIC_PROFILE`:

| Perfil | Serviços |
|---|---|
| `fisio-personal` | Fisioterapia e personal trainer |
| `fisioterapia` | Só fisioterapia |
| `personal` | Só personal trainer |

O perfil define os serviços, o menu, as palavras da triagem ("dor no joelho" → fisioterapia) e
a grade de exemplo do seed. Os dados do negócio (nome, endereço, preços) continuam em
`src/content/clinic.ts`.

- **Novo perfil:** acrescente em `src/profiles/index.ts`. O `npm test` confere os limites do
  WhatsApp e as palavras-chave de todos os perfis.
- **Nunca mude o código** (`code`) de um serviço que já tem agendamentos.
- **Trocar o perfil de uma instalação** não apaga nada: agendamentos de um serviço que saiu do
  perfil continuam visíveis e canceláveis.

## Desenvolvimento e testes

```bash
npm install          # também gera o Prisma Client
npm run dev          # sem Docker: precisa de um PostgreSQL em DATABASE_URL
npm run typecheck
npm test             # unidade; os testes de banco são pulados sem TEST_DATABASE_URL
```

Os testes de integração precisam de um PostgreSQL **descartável**, porque gravam dados e não
limpam:

```bash
docker run -d --name chatbot-pg-teste -e POSTGRES_PASSWORD=teste -p 127.0.0.1:55432:5432 postgres:18.6-alpine3.24
export TEST_DATABASE_URL=postgresql://postgres:teste@127.0.0.1:55432/postgres
DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
npm test
docker rm -f -v chatbot-pg-teste
```

No PowerShell, troque as duas linhas de variável por
`$env:TEST_DATABASE_URL = "postgresql://postgres:teste@127.0.0.1:55432/postgres"; $env:DATABASE_URL = $env:TEST_DATABASE_URL`
e rode `npx prisma migrate deploy` em seguida.

## Problemas comuns

Os códigos de erro da Meta aparecem nos logs (`docker compose logs app`), sem dados de clientes.

| Sintoma | Causa provável |
|---|---|
| A Meta não valida a URL do webhook | ngrok parado, URL sem `/webhook` ou token diferente de `WHATSAPP_VERIFY_TOKEN`. |
| Log: `webhook recusado: assinatura ausente ou inválida` | `WHATSAPP_APP_SECRET` errado: é a chave secreta do **app**, não o token. |
| O bot recebe mas não responde; código `190` | Token expirado (o temporário dura 24 h). |
| Código `131030` | Número fora da lista de destinatários de teste. |
| Nada chega ao webhook | Campo `messages` não assinado. Com número próprio, assine o app na conta do WhatsApp: `POST /{WABA_ID}/subscribed_apps`. |
| O servidor não sobe | A mensagem lista o que falta (nunca o valor). Em produção, também são exigidos TLS no banco, política em https, `RECEPTION_WHATSAPP` e conteúdo sem `PREENCHER`. |
